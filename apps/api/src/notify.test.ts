import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDomainEvent,
  createUuidV7,
  type DomainEvent,
  type Uuid,
} from '@h3/domain';
import {
  createInMemoryStore,
  type OperationalRecommendationRecord,
  type OutboxConsumer,
  type OutboxMessage,
} from '@h3/db';
import { InMemoryTelemetry } from '@h3/telemetry';
import { getApiConfig } from '@h3/config';
import { DEV_TENANT_ID } from './application.js';
import { buildApiApp } from './app.js';
import {
  NotifyingOutboxConsumer,
  WebhookNotificationDelivery,
  type NotificationDelivery,
} from './notify.js';

const apps: Array<Awaited<ReturnType<typeof buildApiApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

let idSequence = 1;
function testId(): Uuid {
  const value = idSequence++;
  return createUuidV7(
    1_700_000_000_000 + value,
    new Uint8Array(10).fill((value % 250) + 1),
  );
}

function message(event: DomainEvent): OutboxMessage {
  return {
    id: testId(),
    event,
    availableAt: event.occurredAt,
    attemptCount: 0,
  };
}

function event(
  type: DomainEvent['type'],
  overrides: Partial<DomainEvent> = {},
): DomainEvent {
  return createDomainEvent({
    id: testId(),
    type,
    producer: 'notify-test',
    tenantId: DEV_TENANT_ID,
    projectId: testId(),
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    ...overrides,
  });
}

/**
 * A real project, created the same way `operator.test.ts` does: through the
 * app's own HTTP route, rather than hand-building a `VideoProject` record.
 * `operationalRecommendations.create` scope-checks against `projects`, so
 * every recommendation seeded directly below needs one of these first.
 */
async function createProject(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<Uuid> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      authorization: 'Bearer test-token',
      'idempotency-key': `${prefix}-project`,
    } satisfies InjectOptions['headers'],
    payload: {
      title: `${prefix} project`,
      brief: 'A project for notify tests.',
      targetDurationSeconds: 3,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `Expected 201, got ${response.statusCode}: ${response.body}`,
    );
  }
  return response.json().project.id as Uuid;
}

class NoopConsumer implements OutboxConsumer {
  readonly calls: OutboxMessage[] = [];
  async consume(message: OutboxMessage): Promise<void> {
    this.calls.push(message);
  }
}

class ThrowingConsumer implements OutboxConsumer {
  async consume(): Promise<never> {
    throw new Error('operator consume failed');
  }
}

class RecordingDelivery implements NotificationDelivery {
  readonly bodies: Array<Readonly<Record<string, unknown>>> = [];
  async deliver(body: Readonly<Record<string, unknown>>): Promise<void> {
    this.bodies.push(body);
  }
}

class ThrowingDelivery implements NotificationDelivery {
  calls = 0;
  async deliver(): Promise<never> {
    this.calls += 1;
    throw new Error('webhook unreachable');
  }
}

describe('NotifyingOutboxConsumer', () => {
  it('always runs the inner (operator) consumer first, and only attempts delivery for notifiable event types', async () => {
    const inner = new NoopConsumer();
    const delivery = new RecordingDelivery();
    const consumer = new NotifyingOutboxConsumer({ inner, delivery });

    await consumer.consume(message(event('attempt.accepted')));
    expect(inner.calls).toHaveLength(1);
    expect(delivery.bodies).toHaveLength(0);

    await consumer.consume(message(event('executor.unavailable')));
    expect(inner.calls).toHaveLength(2);
    expect(delivery.bodies).toHaveLength(1);
  });

  it('propagates an inner (operator) failure and never attempts delivery for that message', async () => {
    const inner = new ThrowingConsumer();
    const delivery = new RecordingDelivery();
    const consumer = new NotifyingOutboxConsumer({ inner, delivery });

    await expect(
      consumer.consume(message(event('executor.unavailable'))),
    ).rejects.toThrow('operator consume failed');
    expect(delivery.bodies).toHaveLength(0);
  });

  it('swallows a delivery failure -- consume() still resolves and records the failure on a span', async () => {
    const inner = new NoopConsumer();
    const delivery = new ThrowingDelivery();
    const telemetry = new InMemoryTelemetry();
    const consumer = new NotifyingOutboxConsumer({
      inner,
      delivery,
      telemetry,
    });

    await expect(
      consumer.consume(message(event('executor.unavailable'))),
    ).resolves.toBeUndefined();
    expect(delivery.calls).toBe(1);
    expect(inner.calls).toHaveLength(1);

    const span = telemetry
      .getSpans()
      .find((candidate) => candidate.name === 'operator.notify');
    if (!span) throw new Error('Expected an operator.notify span.');
    expect(span.status).toBe('error');
    expect(span.attributes.result).toBe('failure');
  });

  it('carries the allowlisted, sanitized payload fields for executor.unavailable and project.budget_denied', async () => {
    const inner = new NoopConsumer();
    const delivery = new RecordingDelivery();
    const consumer = new NotifyingOutboxConsumer({ inner, delivery });

    const unavailable = event('executor.unavailable', {
      payload: {
        workflowRevisionId: testId(),
        reasonCode: 'EXECUTOR_UNAVAILABLE',
      },
    });
    await consumer.consume(message(unavailable));
    expect(delivery.bodies[0]).toMatchObject({
      eventType: 'executor.unavailable',
      reasonCode: 'EXECUTOR_UNAVAILABLE',
      workflowRevisionId: unavailable.payload.workflowRevisionId,
    });

    const budgetDenied = event('project.budget_denied', {
      payload: { reason: 'budget', estimatedCostMicrousd: 50_000 },
    });
    await consumer.consume(message(budgetDenied));
    expect(delivery.bodies[1]).toMatchObject({
      eventType: 'project.budget_denied',
      reason: 'budget',
      estimatedCostMicrousd: 50_000,
    });
  });

  it('does not notify on a success event even when it shares a project with a notifiable one', async () => {
    const inner = new NoopConsumer();
    const delivery = new RecordingDelivery();
    const consumer = new NotifyingOutboxConsumer({ inner, delivery });

    await consumer.consume(message(event('project.created')));
    await consumer.consume(message(event('attempt.accepted')));
    await consumer.consume(message(event('run.pinned')));
    expect(delivery.bodies).toHaveLength(0);
  });

  it('looks up the finding for recommendation.created and includes its sanitized title and detail', async () => {
    const store = createInMemoryStore();
    const app = buildApiApp({
      store,
      telemetry: new InMemoryTelemetry(),
      idGenerator: { next: testId },
      config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
    });
    apps.push(app);
    const projectId = await createProject(app, 'lookup-finding');
    const trigger = event('executor.unavailable', { projectId });
    await store.withTransaction((repositories) =>
      repositories.events.append(trigger),
    );
    const recommendation: OperationalRecommendationRecord = {
      id: testId(),
      tenantId: DEV_TENANT_ID,
      projectId,
      triggerEventId: trigger.id,
      severity: 'critical',
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      title: 'Wait for the executor to recover',
      detail: 'The execution service is unavailable.',
      evidenceReferencesJson: [],
      proposedActionType: 'wait_for_executor',
      proposedResourceIdsJson: [],
      status: 'pending',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.withTransaction((repositories) =>
      repositories.operationalRecommendations.create(recommendation),
    );

    const inner = new NoopConsumer();
    const delivery = new RecordingDelivery();
    const consumer = new NotifyingOutboxConsumer({ inner, delivery });
    const created = event('recommendation.created', {
      projectId,
      payload: {
        recommendationId: recommendation.id,
        severity: 'critical',
        recommendationCode: 'EXECUTOR_UNAVAILABLE',
        proposedActionType: 'wait_for_executor',
        triggeringEventType: 'executor.unavailable',
      },
    });

    await store.withTransaction((repositories) =>
      consumer.consume(message(created), repositories),
    );

    expect(delivery.bodies[0]).toMatchObject({
      eventType: 'recommendation.created',
      recommendationId: recommendation.id,
      severity: 'critical',
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      title: 'Wait for the executor to recover',
      detail: 'The execution service is unavailable.',
    });
  });

  it('redacts a bearer token, a generic credential, and a filesystem path from the finding detail before delivery', async () => {
    const store = createInMemoryStore();
    const app = buildApiApp({
      store,
      telemetry: new InMemoryTelemetry(),
      idGenerator: { next: testId },
      config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
    });
    apps.push(app);
    const projectId = await createProject(app, 'redact-finding');
    const trigger = event('executor.unavailable', { projectId });
    await store.withTransaction((repositories) =>
      repositories.events.append(trigger),
    );
    const recommendation: OperationalRecommendationRecord = {
      id: testId(),
      tenantId: DEV_TENANT_ID,
      projectId,
      triggerEventId: trigger.id,
      severity: 'critical',
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      title: 'Escalate to on-call',
      detail:
        'Escalate to on-call. Bearer fake-vo-token granted access. ' +
        'token=zzzz1111secret was used. Path /Users/ops/.ssh/id_rsa was read.',
      evidenceReferencesJson: [],
      proposedActionType: 'request_human_review',
      proposedResourceIdsJson: [],
      status: 'pending',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.withTransaction((repositories) =>
      repositories.operationalRecommendations.create(recommendation),
    );

    const inner = new NoopConsumer();
    const delivery = new RecordingDelivery();
    const consumer = new NotifyingOutboxConsumer({ inner, delivery });
    const created = event('recommendation.created', {
      projectId,
      payload: { recommendationId: recommendation.id },
    });

    await store.withTransaction((repositories) =>
      consumer.consume(message(created), repositories),
    );

    const body = delivery.bodies[0];
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('fake-vo-token');
    expect(serialized).not.toContain('zzzz1111secret');
    expect(serialized).not.toContain('/Users/ops/.ssh/id_rsa');
    expect(body?.detail).toContain('[redacted]');
  });
});

describe('WebhookNotificationDelivery', () => {
  it('POSTs a bounded JSON body to the configured URL with a JSON content-type', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const delivery = new WebhookNotificationDelivery({
      webhookUrl: 'https://hooks.example.test/h3',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await delivery.deliver({ eventType: 'executor.unavailable' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.test/h3');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      eventType: 'executor.unavailable',
    });
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 }));
    const delivery = new WebhookNotificationDelivery({
      webhookUrl: 'https://hooks.example.test/h3',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(delivery.deliver({})).rejects.toThrow('500');
  });

  it('aborts and rejects once the configured timeout elapses', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const delivery = new WebhookNotificationDelivery({
      webhookUrl: 'https://hooks.example.test/h3',
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(delivery.deliver({})).rejects.toThrow();
  });
});

async function drain(dispatcher: {
  pollOnce(): Promise<boolean>;
}): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (!(await dispatcher.pollOnce())) return;
  }
  throw new Error('Outbox did not drain in the test bound.');
}

describe('buildApiApp notify wiring', () => {
  it('leaves the outbox path byte-for-byte unchanged when NOTIFY_WEBHOOK_URL is unset', async () => {
    const store = createInMemoryStore();
    const telemetry = new InMemoryTelemetry();
    const notifyFetchImpl = vi.fn();
    const app = buildApiApp({
      store,
      telemetry,
      idGenerator: { next: testId },
      config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
      notifyFetchImpl: notifyFetchImpl as unknown as typeof fetch,
    });
    apps.push(app);
    const dispatcher = (
      app as unknown as {
        operationalDispatcher: { pollOnce(): Promise<boolean> };
      }
    ).operationalDispatcher;

    await store.withTransaction(async (repositories) => {
      const trigger = event('executor.unavailable', { projectId: testId() });
      await repositories.events.append(trigger);
      await repositories.outbox.enqueue(trigger);
    });
    expect(await dispatcher.pollOnce()).toBe(true);
    expect(notifyFetchImpl).not.toHaveBeenCalled();
    expect(
      telemetry.getSpans().some((span) => span.name === 'operator.notify'),
    ).toBe(false);
  });

  it('delivers a recommendation.created finding to the configured webhook through the real dispatcher', async () => {
    const store = createInMemoryStore();
    const telemetry = new InMemoryTelemetry();
    const notifyFetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const app = buildApiApp({
      store,
      telemetry,
      idGenerator: { next: testId },
      config: getApiConfig({
        NODE_ENV: 'test',
        DEV_AUTH_TOKEN: 'test-token',
        NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/h3',
      }),
      notifyFetchImpl: notifyFetchImpl as unknown as typeof fetch,
    });
    apps.push(app);
    const dispatcher = (
      app as unknown as {
        operationalDispatcher: { pollOnce(): Promise<boolean> };
      }
    ).operationalDispatcher;

    const projectId = await createProject(app, 'notify-delivered');
    await drain(dispatcher); // flush project-creation noise before counting calls
    await store.withTransaction(async (repositories) => {
      const trigger = event('executor.unavailable', { projectId });
      await repositories.events.append(trigger);
      await repositories.outbox.enqueue(trigger);
    });

    // executor.unavailable is itself notifiable, so it fires a webhook call
    // on top of the recommendation it produces: two messages, two calls.
    expect(await dispatcher.pollOnce()).toBe(true); // trigger -> recommendation.created, notifies "executor.unavailable"
    expect(await dispatcher.pollOnce()).toBe(true); // recommendation.created -> notifies "recommendation.created"
    expect(await dispatcher.pollOnce()).toBe(false);
    expect(notifyFetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = notifyFetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.test/h3');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      eventType: 'recommendation.created',
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
    });
  });

  it('never re-runs the operator when the webhook is permanently unreachable', async () => {
    const store = createInMemoryStore();
    const telemetry = new InMemoryTelemetry();
    const notifyFetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const app = buildApiApp({
      store,
      telemetry,
      idGenerator: { next: testId },
      config: getApiConfig({
        NODE_ENV: 'test',
        DEV_AUTH_TOKEN: 'test-token',
        NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/h3',
      }),
      notifyFetchImpl: notifyFetchImpl as unknown as typeof fetch,
    });
    apps.push(app);
    const dispatcher = (
      app as unknown as {
        operationalDispatcher: { pollOnce(): Promise<boolean> };
      }
    ).operationalDispatcher;

    const projectId = await createProject(app, 'notify-unreachable');
    await drain(dispatcher); // flush project-creation noise before counting calls
    await store.withTransaction(async (repositories) => {
      const trigger = event('executor.unavailable', { projectId });
      await repositories.events.append(trigger);
      await repositories.outbox.enqueue(trigger);
    });

    expect(await dispatcher.pollOnce()).toBe(true); // trigger -> one recommendation; notify fails, swallowed, still delivered
    expect(await dispatcher.pollOnce()).toBe(true); // recommendation.created; notify fails, swallowed, still delivered
    expect(await dispatcher.pollOnce()).toBe(false); // nothing left to retry
    expect(notifyFetchImpl).toHaveBeenCalledTimes(2);

    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs).toHaveLength(1);
    const recommendations = await store.withTransaction((repositories) =>
      repositories.recommendations.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(recommendations).toHaveLength(1);
  });
});
