import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  createDomainEvent,
  createUuidV7,
  type DomainEvent,
  type IdGenerator,
  type Uuid,
} from '@h3/domain';
import {
  createInMemoryStore,
  RepositoryError,
  type OutboxDispatcher,
  type Repositories,
  type TransactionalStore,
} from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import { InMemoryTelemetry, MetricsRegistry } from '@h3/telemetry';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { DEV_TENANT_ID } from './application.js';
import { buildApiApp } from './app.js';
import {
  createOperationalToolServices,
  OperationalPiAdapter,
  safeRecommendationText,
  OPERATIONAL_SUBMISSION_MAX_REJECTIONS,
  OPERATIONAL_TRIGGER_EVENT_TYPES,
  type FauxOperationalScript,
} from './operator.js';

const auth = { authorization: 'Bearer test-token' };
const apps: Array<Awaited<ReturnType<typeof buildApiApp>>> = [];
let idSequence = 1;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function testId(): Uuid {
  const value = idSequence++;
  return createUuidV7(
    1_700_000_000_000 + value,
    new Uint8Array(10).fill((value % 250) + 1),
  );
}

function testIds(): IdGenerator {
  return { next: testId };
}

interface TestApp {
  readonly app: Awaited<ReturnType<typeof buildApiApp>>;
  readonly store: ReturnType<typeof createInMemoryStore>;
  readonly telemetry: InMemoryTelemetry;
  readonly dispatcher: OutboxDispatcher;
  readonly adapter: OperationalPiAdapter;
}

function internals(app: Awaited<ReturnType<typeof buildApiApp>>): {
  readonly operationalDispatcher: OutboxDispatcher;
  readonly operationalPiAdapter: OperationalPiAdapter;
} {
  return app as unknown as {
    readonly operationalDispatcher: OutboxDispatcher;
    readonly operationalPiAdapter: OperationalPiAdapter;
  };
}

async function setup(script?: FauxOperationalScript): Promise<TestApp> {
  const store = createInMemoryStore();
  const telemetry = new InMemoryTelemetry();
  const comfy = new DeterministicFakeComfyService();
  const adapter = script
    ? new OperationalPiAdapter({
        store,
        tenantId: DEV_TENANT_ID,
        idGenerator: testIds(),
        telemetry,
        script,
        services: (repositories) =>
          createOperationalToolServices(repositories, DEV_TENANT_ID, {
            mode: 'fake',
            getExecutorReadiness: async () => ({
              mode: 'fake',
              ready: true,
              checkedAt: '2026-01-01T00:00:00.000Z',
              capabilityFingerprint: 'test-fingerprint',
            }),
          }),
      })
    : undefined;
  const app = buildApiApp({
    store,
    telemetry,
    idGenerator: testIds(),
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
    comfyClient: new FakeComfyClient(comfy),
    ...(adapter ? { operationalAdapter: adapter } : {}),
  });
  apps.push(app);
  const values = internals(app);
  return {
    app,
    store,
    telemetry,
    dispatcher: values.operationalDispatcher,
    adapter: values.operationalPiAdapter,
  };
}

/**
 * Builds a `streamFnOverride` backed by a throwaway `fauxProvider()` -- the
 * same public test double the faux path already trusts, replayed for a
 * non-faux `provider` string so `runPi`'s non-faux branch runs for real with
 * no network call (75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md step 3). Faux's
 * `streamSimple` does not validate the `model` it is called with against its
 * own registered model -- it just replays the queued responses -- so this
 * works regardless of what model shape the adapter constructs.
 */
function hostedStreamFn(
  responses: readonly FauxResponseStep[],
  onCall?: (...args: Parameters<StreamFn>) => void,
): StreamFn {
  const faux = fauxProvider({
    provider: 'deepseek-test-stub',
    models: [{ id: 'stub-model', name: 'stub-model' }],
  });
  faux.setResponses([...responses]);
  return (model, context, options) => {
    onCall?.(model, context, options);
    return faux.provider.streamSimple(model, context, options);
  };
}

/**
 * The text a transcript actually puts in front of the model -- prompt and
 * tool-result blocks alike. Asserting on this rather than on
 * `JSON.stringify(messages)` keeps a needle containing quotes readable.
 */
function transcriptText(messages: readonly unknown[]): string {
  return messages
    .flatMap((message) => {
      const content = (message as { readonly content?: unknown }).content;
      return Array.isArray(content) ? (content as unknown[]) : [];
    })
    .flatMap((block) => {
      const text = (block as { readonly text?: unknown }).text;
      return typeof text === 'string' ? [text] : [];
    })
    .join('\n');
}

/**
 * Wraps a store so a test can observe how many transactions are open at any
 * moment, and make one fail on demand. The depth reading is what proves the
 * model call runs with none open (7E step 3 review, finding 3).
 */
interface TrackedStore {
  readonly store: TransactionalStore;
  readonly openDepth: () => number;
  readonly opened: () => number;
  failNextTransaction: boolean;
}

function trackTransactions(inner: TransactionalStore): TrackedStore {
  let depth = 0;
  let opened = 0;
  const tracked: TrackedStore = {
    store: {
      withTransaction: async (work) => {
        if (tracked.failNextTransaction) {
          tracked.failNextTransaction = false;
          throw new Error('simulated persistence failure');
        }
        depth += 1;
        opened += 1;
        try {
          return await inner.withTransaction(work);
        } finally {
          depth -= 1;
        }
      },
    },
    openDepth: () => depth,
    opened: () => opened,
    failNextTransaction: false,
  };
  return tracked;
}

async function setupHosted(
  streamFnOverride: StreamFn,
  options?: {
    readonly apiKey?: string;
    readonly timeoutMs?: number;
    readonly maxRunCostMicrousd?: number;
    readonly maxRunTokens?: number;
    readonly metrics?: MetricsRegistry;
    readonly wrapStore?: (inner: TransactionalStore) => TransactionalStore;
  },
): Promise<TestApp> {
  const inMemory = createInMemoryStore();
  const store = options?.wrapStore ? options.wrapStore(inMemory) : inMemory;
  const telemetry = new InMemoryTelemetry();
  const comfy = new DeterministicFakeComfyService();
  const adapter = new OperationalPiAdapter({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator: testIds(),
    telemetry,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxRunCostMicrousd !== undefined
      ? { maxRunCostMicrousd: options.maxRunCostMicrousd }
      : {}),
    ...(options?.maxRunTokens !== undefined
      ? { maxRunTokens: options.maxRunTokens }
      : {}),
    ...(options?.metrics ? { metrics: options.metrics } : {}),
    streamFnOverride,
    services: (repositories) =>
      createOperationalToolServices(repositories, DEV_TENANT_ID, {
        mode: 'fake',
        getExecutorReadiness: async () => ({
          mode: 'fake',
          ready: true,
          checkedAt: '2026-01-01T00:00:00.000Z',
          capabilityFingerprint: 'test-fingerprint',
        }),
      }),
  });
  const app = buildApiApp({
    store,
    telemetry,
    idGenerator: testIds(),
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
    comfyClient: new FakeComfyClient(comfy),
    operationalAdapter: adapter,
  });
  apps.push(app);
  const values = internals(app);
  return {
    app,
    store: inMemory,
    telemetry,
    dispatcher: values.operationalDispatcher,
    adapter: values.operationalPiAdapter,
  };
}

async function request(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  options: InjectOptions,
) {
  return app.inject({ ...options, headers: { ...auth, ...options.headers } });
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<Uuid> {
  const response = await request(app, {
    method: 'POST',
    url: '/v1/projects',
    headers: { 'idempotency-key': `${prefix}-project` },
    payload: {
      title: `${prefix} project`,
      brief: 'A project for operational Pi tests.',
      targetDurationSeconds: 3,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id as Uuid;
}

/**
 * Phase 7D removed `POST /v1/projects/:projectId/plan` and
 * `.../storyboard/approve`; shots are no longer listed or otherwise
 * addressable. Seed one the way a real client now must: submit `POST
 * /v1/runs` with a graph that fails validation, which creates the project's
 * implicit shot (and a `shot.created` domain event) without ever reaching
 * attempt creation, leaving the shot in `approved_for_generation`.
 */
async function createApprovedShot(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<{ readonly projectId: Uuid; readonly shotId: Uuid }> {
  const projectId = await createProject(app, prefix);
  const invalidRun = await request(app, {
    method: 'POST',
    url: '/v1/runs',
    headers: { 'idempotency-key': `${prefix}-seed-run` },
    payload: { projectId, editorGraph: {}, apiGraph: {} },
  });
  expect(invalidRun.statusCode).toBe(422);
  const events = await request(app, {
    method: 'GET',
    url: `/v1/projects/${projectId}/events`,
  });
  const shotCreated = (
    events.json().events as ReadonlyArray<Record<string, unknown>>
  ).find((event) => event.type === 'shot.created');
  const shotId = shotCreated?.shotId as Uuid | undefined;
  if (!shotId) throw new Error('Expected a shot.created event with a shotId.');
  return { projectId, shotId };
}

async function appendEvent(
  store: TransactionalStore,
  input: {
    readonly tenantId?: Uuid;
    readonly projectId: Uuid;
    readonly type: DomainEvent['type'];
    readonly shotId?: Uuid;
    readonly attemptId?: Uuid;
    readonly traceId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  },
): Promise<DomainEvent> {
  const event = createDomainEvent({
    id: testId(),
    type: input.type,
    producer: 'operator-test',
    tenantId: input.tenantId ?? DEV_TENANT_ID,
    projectId: input.projectId,
    ...(input.shotId ? { shotId: input.shotId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
  });
  await store.withTransaction(async (repositories) => {
    await repositories.events.append(event);
    await repositories.outbox.enqueue(event);
  });
  return event;
}

async function drain(dispatcher: OutboxDispatcher): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (!(await dispatcher.pollOnce())) return;
  }
  throw new Error('Outbox did not drain in the test bound.');
}

async function recommendations(
  store: ReturnType<typeof createInMemoryStore>,
  projectId: Uuid,
) {
  return store.withTransaction((repositories) =>
    repositories.recommendations.listByProject(DEV_TENANT_ID, projectId),
  );
}

describe('Checkpoint 5 operational Pi adapter', () => {
  it('consumes a durable event, persists a bounded recommendation, and reuses it on duplicate delivery', async () => {
    const { app, store, telemetry, dispatcher, adapter } = await setup();
    const projectId = await createProject(app, 'duplicate');
    await drain(dispatcher);
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
      payload: {
        prompt: 'must never reach Pi or telemetry',
        secret: 'private-value',
      },
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    const first = (await recommendations(store, projectId))[0];
    if (!first) throw new Error('Expected an operational recommendation.');
    expect(first).toMatchObject({
      triggerEventId: event.id,
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      proposedActionType: 'wait_for_executor',
      status: 'pending',
      evidenceReferencesJson: [{ type: 'domain_event', resourceId: event.id }],
    });
    expect(JSON.stringify(first)).not.toContain('private-value');

    const duplicate = await adapter.processEvent(event);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.recommendation?.id).toBe(first.id);
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs).toHaveLength(1);
    expect(duplicate.agentRun?.id).toBe(first.piAgentRunId);
    expect(telemetry.getSpans().map((span) => span.name)).toEqual(
      expect.arrayContaining(['agent.operator.run', 'agent.operator.tool']),
    );
    expect(JSON.stringify(telemetry.getSpans())).not.toContain('private-value');
    expect(JSON.stringify(telemetry.getSpans())).not.toContain(
      'must never reach',
    );
  });

  it('does not process a trigger from another tenant or leak cross-project evidence', async () => {
    const { app, store, dispatcher } = await setup();
    const projectId = await createProject(app, 'scope');
    await drain(dispatcher);
    const foreignTenant = testId();
    const event = await appendEvent(store, {
      tenantId: foreignTenant,
      projectId,
      type: 'attempt.failed',
      payload: { code: 'COMFY_EXECUTION_FAILED' },
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await recommendations(store, projectId)).toEqual([]);
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs).toEqual([]);
    expect(
      (await internals(app).operationalPiAdapter.processEvent(event)).reason,
    ).toBe('out_of_scope');
  });

  it('normalizes an unsafe model action and requires the human API action', async () => {
    const { app, store, adapter } = await setup({
      output: {
        severity: 'critical',
        recommendationCode: 'MODEL_SUPPLIED_CODE',
        title: 'Unsafe retry proposal',
        detail: 'The model asked for a retry before executor readiness.',
        proposedActionType: 'retry_attempt',
      },
    });
    const projectId = await createProject(app, 'policy');
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });
    const processed = await adapter.processEvent(event);
    const recommendation = processed.recommendation;
    if (!recommendation) throw new Error('Expected recommendation.');
    expect(recommendation.proposedActionType).toBe('wait_for_executor');
    expect(
      await store.withTransaction((repositories) =>
        repositories.attempts.listByProject(DEV_TENANT_ID, projectId),
      ),
    ).toEqual([]);

    const applied = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'policy-apply' },
      payload: {
        expectedVersion: 1,
        actionType: 'retry_attempt',
        seed: 987654,
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().recommendation.status).toBe('applied');
    expect(applied.json().attempt).toBeUndefined();

    const dismissEvent = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });
    const dismissResult = await adapter.processEvent(dismissEvent);
    const dismissRecommendation = dismissResult.recommendation;
    if (!dismissRecommendation)
      throw new Error('Expected dismiss recommendation.');
    const dismissed = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${dismissRecommendation.id}/dismiss`,
      headers: { 'idempotency-key': 'policy-dismiss' },
      payload: { expectedVersion: 1 },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().recommendation.status).toBe('dismissed');
  });

  it('recommends a retry for a failed attempt but spends budget only after human apply', async () => {
    const { app, store, dispatcher } = await setup();
    const { projectId, shotId } = await createApprovedShot(app, 'retry');
    const created = await request(app, {
      method: 'POST',
      url: `/v1/shots/${shotId}/attempts`,
      headers: { 'idempotency-key': 'retry-attempt' },
      payload: { scenario: 'execution-failure' },
    });
    expect(created.statusCode).toBe(201);
    const sourceAttemptId = created.json().attempt.id as Uuid;
    const worker = (
      app as unknown as {
        generationWorker: { processOnce(): Promise<boolean> };
      }
    ).generationWorker;
    expect(await worker.processOnce()).toBe(true);
    expect(
      (
        await request(app, {
          method: 'GET',
          url: `/v1/attempts/${sourceAttemptId}`,
        })
      ).json().attempt.status,
    ).toBe('failed');
    await drain(dispatcher);

    const recommendation = (await recommendations(store, projectId)).find(
      (candidate) => candidate.attemptId === sourceAttemptId,
    );
    if (!recommendation)
      throw new Error('Expected failed-attempt recommendation.');
    expect(recommendation.proposedActionType).toBe('retry_attempt');
    const staleApply = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'retry-stale-apply' },
      payload: { expectedVersion: recommendation.version + 1 },
    });
    expect(staleApply.statusCode).toBe(409);
    expect(
      (
        await request(app, {
          method: 'GET',
          url: `/v1/projects/${projectId}/attempts`,
        })
      ).json().attempts,
    ).toHaveLength(1);

    const applied = await request(app, {
      method: 'POST',
      url: `/v1/projects/${projectId}/operator/recommendations/${recommendation.id}/apply`,
      headers: { 'idempotency-key': 'retry-recommendation-apply' },
      payload: { expectedVersion: recommendation.version },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().recommendation.status).toBe('applied');
    expect(applied.json().attempt.sourceAttemptId).toBe(sourceAttemptId);
    expect(
      (
        await request(app, {
          method: 'GET',
          url: `/v1/projects/${projectId}/attempts`,
        })
      ).json().attempts,
    ).toHaveLength(2);
  });

  it('emits recommendation.created exactly once, in domain_events and the outbox, with the full payload contract and scoping', async () => {
    const { app, store, dispatcher } = await setup();
    const projectId = await createProject(app, 'emit-once');
    await drain(dispatcher);

    const traceId = 'trace-emit-once';
    const event = createDomainEvent({
      id: testId(),
      type: 'executor.unavailable',
      producer: 'operator-test',
      tenantId: DEV_TENANT_ID,
      projectId,
      traceId,
      clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    });
    await store.withTransaction(async (repositories) => {
      await repositories.events.append(event);
      await repositories.outbox.enqueue(event);
    });

    // Processes the trigger: the operator persists a recommendation and, in
    // the same transaction, appends and enqueues exactly one
    // `recommendation.created`.
    expect(await dispatcher.pollOnce()).toBe(true);

    const recommendation = (await recommendations(store, projectId))[0];
    if (!recommendation) {
      throw new Error('Expected a persisted recommendation.');
    }

    const projectEvents = await store.withTransaction((repositories) =>
      repositories.events.listByProject(projectId),
    );
    const createdEvents = projectEvents.filter(
      (candidate) => candidate.type === 'recommendation.created',
    );
    expect(createdEvents).toHaveLength(1);
    const createdEvent = createdEvents[0];
    if (!createdEvent) {
      throw new Error('Expected a recommendation.created event.');
    }

    expect(createdEvent.projectId).toBe(projectId);
    expect(createdEvent.traceId).toBe(traceId);
    expect(createdEvent.payload.recommendationId).toBe(recommendation.id);
    expect(createdEvent.payload.severity).toBe(recommendation.severity);
    expect(createdEvent.payload.recommendationCode).toBe(
      recommendation.recommendationCode,
    );
    expect(createdEvent.payload.proposedActionType).toBe(
      recommendation.proposedActionType,
    );
    expect(createdEvent.payload.triggeringEventType).toBe(event.type);

    // Exactly one outbox row: the only thing left pending is the
    // `recommendation.created` message itself. It is not a trigger, so
    // draining it is a silent no-op, and after that the outbox is empty --
    // proving there was exactly one new row, not merely that one exists.
    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await dispatcher.pollOnce()).toBe(false);
  });

  it('emits no second event when the identical trigger event is delivered twice (existing-recommendation short-circuit)', async () => {
    const { app, store, dispatcher, adapter } = await setup();
    const projectId = await createProject(app, 'no-loop-existing');
    await drain(dispatcher);
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });

    expect(await dispatcher.pollOnce()).toBe(true); // trigger -> one recommendation.created
    await drain(dispatcher); // drains that recommendation.created message itself

    const before = await store.withTransaction((repositories) =>
      repositories.events.listByProject(projectId),
    );
    expect(
      before.filter((candidate) => candidate.type === 'recommendation.created'),
    ).toHaveLength(1);

    // Re-process the identical trigger event directly: the natural way to
    // reach the early `existing` return at operator.ts:558.
    const duplicate = await adapter.processEvent(event);
    expect(duplicate.duplicate).toBe(true);
    expect(await recommendations(store, projectId)).toHaveLength(1);

    const after = await store.withTransaction((repositories) =>
      repositories.events.listByProject(projectId),
    );
    expect(
      after.filter((candidate) => candidate.type === 'recommendation.created'),
    ).toHaveLength(1);
    expect(await dispatcher.pollOnce()).toBe(false);
  });

  it('propagates a genuine UNIQUE_VIOLATION from create() instead of recovering it, and a later retry finds the committed winner', async () => {
    // 7E step 2 prerequisite finding: the recovery branch this test used to
    // exercise is dead code on PostgreSQL (operator.ts:774) and is deleted.
    // A genuine collision now aborts the transaction and relies on retry --
    // this test proves that shape instead of a same-transaction recovery.
    const { app, store, dispatcher, adapter } = await setup();
    const projectId = await createProject(app, 'race-unique');
    await drain(dispatcher);
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });

    // A concurrent operator instance wins the race and commits first.
    expect(await dispatcher.pollOnce()).toBe(true);
    await drain(dispatcher);
    const winner = (await recommendations(store, projectId))[0];
    if (!winner) throw new Error('Expected the winning recommendation.');

    // This instance's own existence check ran *before* the winner committed
    // -- the TOCTOU window the deleted branch used to guard. Patching only
    // that check (not `create`) reproduces the real race precisely: the
    // in-memory store's own uniqueness constraint, not a fabricated error,
    // is what `create()` collides with below.
    const raced = store.withTransaction(async (repositories) => {
      const patched: Repositories = {
        ...repositories,
        operationalRecommendations: {
          ...repositories.operationalRecommendations,
          findByTriggerEventAndCode: async () => null,
        },
      };
      return adapter.processEventInTransaction(patched, event);
    });
    await expect(raced).rejects.toBeInstanceOf(RepositoryError);
    await expect(raced).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION' });

    // Nothing from the raced attempt survived its transaction's rollback:
    // still exactly the one winner, one recommendation.created event, and
    // one agent run -- no second model run, no orphaned partial state.
    expect(await recommendations(store, projectId)).toHaveLength(1);
    const projectEvents = await store.withTransaction((repositories) =>
      repositories.events.listByProject(projectId),
    );
    expect(
      projectEvents.filter(
        (candidate) => candidate.type === 'recommendation.created',
      ),
    ).toHaveLength(1);
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs).toHaveLength(1);

    // A genuine retry -- unpatched -- takes the early `existing` return and
    // recovers cleanly, without re-running the model.
    const retried = await adapter.processEvent(event);
    expect(retried.duplicate).toBe(true);
    expect(retried.recommendation?.id).toBe(winner.id);
    expect(await recommendations(store, projectId)).toHaveLength(1);
    expect(await dispatcher.pollOnce()).toBe(false);
  });

  it('keeps the trigger set and recommendation.created disjoint, and never re-triggers itself', async () => {
    expect(OPERATIONAL_TRIGGER_EVENT_TYPES).not.toContain(
      'recommendation.created',
    );

    const { app, store, dispatcher, adapter } = await setup();
    const projectId = await createProject(app, 'no-self-trigger');
    await drain(dispatcher);

    const selfEvent = await appendEvent(store, {
      projectId,
      type: 'recommendation.created',
      payload: {
        recommendationId: testId(),
        severity: 'warning',
        recommendationCode: 'SOME_CODE',
        proposedActionType: 'no_action',
        triggeringEventType: 'executor.unavailable',
      },
    });
    const direct = await adapter.processEvent(selfEvent);
    expect(direct).toEqual({
      handled: false,
      duplicate: false,
      reason: 'not_trigger',
    });
    // The self-typed event still sits undelivered; draining it through the
    // real outbox-consumer path must agree with the direct call above.
    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await recommendations(store, projectId)).toEqual([]);

    // Bonus: a genuine finding's own `recommendation.created` message does
    // not re-trigger the operator when the dispatcher drains it.
    await appendEvent(store, { projectId, type: 'executor.unavailable' });
    expect(await dispatcher.pollOnce()).toBe(true); // trigger -> one recommendation
    expect(await recommendations(store, projectId)).toHaveLength(1);
    expect(await dispatcher.pollOnce()).toBe(true); // drains recommendation.created itself
    expect(await recommendations(store, projectId)).toHaveLength(1); // unchanged
    expect(await dispatcher.pollOnce()).toBe(false); // outbox now empty
  });
});

const validRecommendationArgs = {
  severity: 'critical',
  recommendationCode: 'EXECUTOR_UNAVAILABLE',
  title: 'Wait for the executor to recover',
  detail: 'The execution service is unavailable; wait before retrying.',
  proposedActionType: 'wait_for_executor',
};

/**
 * A finding the model authored, distinct from `defaultOutput()`'s for
 * `executor.unavailable` in severity, title and action -- so a test can tell
 * which of the two was persisted.
 */
const modelAuthoredArgs = {
  severity: 'info',
  recommendationCode: 'MODEL_AUTHORED_CODE',
  title: 'Model authored title',
  detail: 'The model reached this conclusion from the evidence tools.',
  proposedActionType: 'no_action',
};

describe('Phase 7E step 3: a non-faux provider via submit_recommendation', () => {
  /**
   * 75-PHASE-7E-STEP-3-FOLLOWUP-TOOL-USE.md, W8. One table over how models
   * actually emit tool calls, rather than the single sequential shape step 3
   * assumed. Rows 2, 3 and 4 are the regression tests for D1 (a submission
   * batched with another call never terminates, so it left the last
   * assistant message) and D2 (a schema-perfect conclusion discarded over a
   * repairable detail); they fail against `9e94d0d`.
   *
   * Every expectation discriminates the model's own conclusion from
   * `defaultOutput()`'s for `executor.unavailable`, which differs from it in
   * severity, title and action. `recommendationCode` is deliberately not a
   * discriminator: `completeRun` always takes it from the event
   * (`recommendationCodeFor`), never from the model.
   */
  const modelPersisted = {
    severity: 'info',
    title: 'Model authored title',
    proposedActionType: 'no_action',
    recommendationCode: 'EXECUTOR_UNAVAILABLE',
  };
  const fallbackPersisted = {
    severity: 'critical',
    title: 'Wait for the executor to recover',
    proposedActionType: 'wait_for_executor',
    recommendationCode: 'EXECUTOR_UNAVAILABLE',
  };
  type ToolArgs = Record<string, unknown>;
  /**
   * One assistant message: the submission, plus a `get_project_status` call
   * per extra argument object. The read call is what makes the batch
   * non-terminating -- pi terminates only when *every* finalized call in a
   * batch does (`agent-loop.js:376`).
   */
  const submits = (args: ToolArgs, ...reads: ToolArgs[]) =>
    fauxAssistantMessage([
      fauxToolCall('submit_recommendation', args),
      ...reads.map((read) => fauxToolCall('get_project_status', read)),
    ]);
  const fenced = (args: ToolArgs) =>
    fauxAssistantMessage(
      'Here is my conclusion:\n```json\n' +
        JSON.stringify(args) +
        '\n```\nThat is my final answer.',
    );

  const behaviours: ReadonlyArray<{
    readonly row: number;
    readonly name: string;
    readonly responses: readonly FauxResponseStep[];
    readonly persisted: Record<string, unknown>;
    readonly status: 'succeeded' | 'failed';
    readonly failureCode?: string;
    /**
     * Which tier the run span must report the finding came from (W2), or
     * absent when the run never got as far as looking for one.
     */
    readonly result?: 'submitted' | 'rejected_cap' | 'text' | 'none';
    /** Text the bounce must have put in front of the model on its next turn. */
    readonly retriedWith?: string;
  }> = [
    {
      row: 1,
      name: 'submits alone',
      responses: [submits(modelAuthoredArgs)],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
    },
    {
      row: 2,
      name: 'submits batched with a read call (D1)',
      responses: [
        submits(modelAuthoredArgs, {}),
        fauxAssistantMessage('Done.'),
      ],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
    },
    {
      row: 3,
      name: 'submits with an extra key (D2)',
      responses: [
        submits({ ...modelAuthoredArgs, reasoning: 'a field it volunteered' }),
      ],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
    },
    {
      row: 4,
      name: 'submits an over-long detail, then corrects it (D2)',
      responses: [
        submits({ ...modelAuthoredArgs, detail: 'x'.repeat(2_280) }),
        submits(modelAuthoredArgs),
      ],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
      retriedWith:
        'detail is 2280 characters; the maximum is 2000. Shorten it.',
    },
    {
      row: 5,
      name: 'submits a bad enum, then corrects it',
      responses: [
        submits({ ...modelAuthoredArgs, severity: 'urgent' }),
        submits(modelAuthoredArgs),
      ],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
      retriedWith:
        'severity must be one of "info", "warning", "critical" (received "urgent").',
    },
    {
      row: 6,
      name: 'submits twice with different content: the later one wins',
      responses: [
        submits(
          {
            ...modelAuthoredArgs,
            severity: 'warning',
            title: 'An earlier conclusion',
            proposedActionType: 'wait_for_executor',
          },
          {},
        ),
        submits(modelAuthoredArgs),
      ],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
    },
    {
      row: 7,
      name: 'submits, then keeps talking: tier 1 still beats the prose',
      responses: [
        submits(modelAuthoredArgs, {}),
        // Parseable, and a *different* finding -- tier 2 would take it if
        // tier 1 had been lost.
        fenced({
          ...modelAuthoredArgs,
          severity: 'critical',
          title: 'Prose afterthought',
          proposedActionType: 'wait_for_executor',
        }),
      ],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'submitted',
    },
    {
      row: 8,
      name: 'exhausts the rejection cap',
      responses: Array.from(
        { length: OPERATIONAL_SUBMISSION_MAX_REJECTIONS },
        () => submits({ ...modelAuthoredArgs, severity: 'urgent' }),
      ),
      persisted: fallbackPersisted,
      status: 'failed',
      result: 'rejected_cap',
      failureCode: 'INVALID_STRUCTURED_OUTPUT',
    },
    {
      row: 9,
      name: 'never submits, JSON in fenced prose (tier 2)',
      responses: [fenced(modelAuthoredArgs)],
      persisted: modelPersisted,
      status: 'succeeded',
      result: 'text',
    },
    {
      row: 10,
      name: 'never submits, unparseable prose',
      responses: [
        fauxAssistantMessage('I am not going to return anything structured.'),
      ],
      persisted: fallbackPersisted,
      status: 'failed',
      result: 'none',
      failureCode: 'INVALID_STRUCTURED_OUTPUT',
    },
    {
      row: 11,
      name: 'provider error',
      responses: [
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'simulated provider failure',
        }),
      ],
      persisted: fallbackPersisted,
      status: 'failed',
      failureCode: 'PROVIDER_ERROR',
    },
  ];

  for (const behaviour of behaviours) {
    it(`row ${behaviour.row}: ${behaviour.name}`, async () => {
      const calls: Array<{
        readonly apiKey: string | undefined;
        readonly transcript: string;
      }> = [];
      const metrics = new MetricsRegistry();
      const { app, store, dispatcher, telemetry } = await setupHosted(
        hostedStreamFn(behaviour.responses, (_model, context, options) =>
          calls.push({
            apiKey: options?.apiKey,
            transcript: transcriptText(context.messages),
          }),
        ),
        { apiKey: 'test-deepseek-key', metrics },
      );
      const projectId = await createProject(app, `matrix-${behaviour.row}`);
      await drain(dispatcher);
      const event = await appendEvent(store, {
        projectId,
        type: 'executor.unavailable',
      });

      expect(await dispatcher.pollOnce()).toBe(true);
      const recommendation = (await recommendations(store, projectId))[0];
      if (!recommendation) {
        throw new Error('Expected exactly one persisted recommendation.');
      }
      expect(recommendation).toMatchObject({
        ...behaviour.persisted,
        triggerEventId: event.id,
        status: 'pending',
      });
      const runs = await store.withTransaction((repositories) =>
        repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: behaviour.status,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        ...(behaviour.failureCode
          ? { failureCode: behaviour.failureCode }
          : {}),
      });
      // Step 3's guarantee, asserted on every row rather than one: the
      // resolved key reaches every stream call, and none of them is paid.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.apiKey === 'test-deepseek-key')).toBe(
        true,
      );
      if (behaviour.retriedWith) {
        // The bounce is only worth its retry if the model can read it.
        expect(calls[1]?.transcript).toContain(behaviour.retriedWith);
      }
      // W2: which tier produced the finding is reported, not assumed --
      // `undefined` for a run that failed before it looked for one.
      const runSpans = telemetry
        .getSpans()
        .filter((span) => span.name === 'agent.operator.run');
      expect(runSpans).toHaveLength(1);
      expect(runSpans[0]?.attributes.result).toBe(behaviour.result);
      // W5: the same vocabulary reaches the counter, so degradation is
      // measurable in aggregate and not only per-span. A run that failed
      // before it looked for a tier reports `error`.
      expect(
        metrics
          .snapshot()
          .filter((entry) => entry.name === 'video_operator_output_tier_total'),
      ).toEqual([
        {
          name: 'video_operator_output_tier_total',
          labels: { tier: behaviour.result ?? 'error' },
          value: 1,
        },
      ]);
    });
  }

  it('seeds the scoped identifiers into the prompt, and still denies an out-of-scope identifier the model supplies', async () => {
    const calls: Array<{ readonly promptText: string }> = [];
    const wrongShotId = testId();
    const { app, store, dispatcher, telemetry } = await setupHosted(
      hostedStreamFn(
        [
          // `createApprovedShot` below submits a deliberately invalid
          // graph, which enqueues its own `workflow.revision.invalid`
          // trigger (a genuine operational trigger); `drain` runs the model
          // for it too, so this first response is consumed there, not by
          // the `executor.unavailable` event this test actually cares
          // about.
          fauxAssistantMessage([
            fauxToolCall('submit_recommendation', validRecommendationArgs),
          ]),
          fauxAssistantMessage([
            fauxToolCall('get_shot_status', { shotId: wrongShotId }),
          ]),
          fauxAssistantMessage([
            fauxToolCall('submit_recommendation', validRecommendationArgs),
          ]),
        ],
        (_model, context) =>
          calls.push({ promptText: JSON.stringify(context.messages) }),
      ),
    );
    const { projectId, shotId } = await createApprovedShot(app, 'hosted-scope');
    expect(wrongShotId).not.toBe(shotId);
    await drain(dispatcher);
    await appendEvent(store, {
      projectId,
      shotId,
      type: 'executor.unavailable',
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    // calls[0] belongs to the drained workflow.revision.invalid trigger.
    expect(calls[1]?.promptText).toContain(`projectId=${projectId}`);
    expect(calls[1]?.promptText).toContain(`shotId=${shotId}`);

    const denialEvents = telemetry
      .getSpans()
      .flatMap((span) => span.events)
      .filter((candidate) => candidate.name === 'policy.denial');
    expect(denialEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ code: 'SHOT_SCOPE_DENIED' }),
        }),
      ]),
    );

    // Two recommendations exist for this project -- the drained
    // workflow.revision.invalid trigger's, and the one this test cares
    // about -- so select by code rather than assuming array order.
    const recommendation = (await recommendations(store, projectId)).find(
      (candidate) => candidate.recommendationCode === 'EXECUTOR_UNAVAILABLE',
    );
    if (!recommendation) {
      throw new Error('Expected the run to still complete after the denial.');
    }
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    const run = runs.find(
      (candidate) => candidate.id === recommendation.piAgentRunId,
    );
    expect(run?.status).toBe('succeeded');
  });

  it('splits the claim from the model call: phase 1 commits a running run with no recommendation yet', async () => {
    const { app, store, adapter } = await setupHosted(
      hostedStreamFn([
        fauxAssistantMessage([
          fauxToolCall('submit_recommendation', validRecommendationArgs),
        ]),
      ]),
    );
    const projectId = await createProject(app, 'hosted-phase-split');
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });

    // Phase 1: the same call `OperationalOutboxConsumer.consume` makes
    // inside the claim transaction.
    const phase1 = await store.withTransaction((repositories) =>
      adapter.processEventInTransaction(repositories, event),
    );
    expect(phase1).toMatchObject({ handled: true, duplicate: false });
    expect(phase1.recommendation).toBeUndefined();
    expect(await recommendations(store, projectId)).toEqual([]);
    const runsAfterPhase1 = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runsAfterPhase1).toHaveLength(1);
    expect(runsAfterPhase1[0]?.status).toBe('running');

    // Phase 2: the same call `OperationalOutboxConsumer.afterCommit` makes,
    // once the claim transaction above has already committed -- proven for
    // real, against PostgreSQL, in
    // apps/api/src/operator.deferred.integration.test.ts.
    await adapter.completeDeferredRun(event);

    const recommendation = (await recommendations(store, projectId))[0];
    if (!recommendation) {
      throw new Error('Expected completeDeferredRun to finish the job.');
    }
    expect(recommendation.recommendationCode).toBe('EXECUTOR_UNAVAILABLE');
    const runsAfterPhase2 = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runsAfterPhase2[0]?.status).toBe('succeeded');
  });

  it('never runs the model twice for one trigger: completeDeferredRun is a no-op once a recommendation exists', async () => {
    const calls: number[] = [];
    const { app, store, dispatcher } = await setupHosted(
      hostedStreamFn(
        [
          fauxAssistantMessage([
            fauxToolCall('submit_recommendation', validRecommendationArgs),
          ]),
        ],
        () => calls.push(1),
      ),
    );
    const projectId = await createProject(app, 'hosted-no-double-run');
    await drain(dispatcher);
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    expect(calls).toHaveLength(1);
    const first = (await recommendations(store, projectId))[0];
    if (!first) throw new Error('Expected a persisted recommendation.');

    const internalsApp = app as unknown as {
      readonly operationalPiAdapter: {
        completeDeferredRun(event: DomainEvent): Promise<void>;
      };
    };
    await internalsApp.operationalPiAdapter.completeDeferredRun(event);

    expect(calls).toHaveLength(1); // no second model call
    const after = await recommendations(store, projectId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first.id);
  });
});

describe('Phase 7E step 3 review: deferred-run isolation and bounds', () => {
  it('calls the model with no transaction open, and opens a short one per tool call', async () => {
    // Finding 3. Moving the call out of the *claim* transaction was only half
    // the `OutboxConsumer.afterCommit` contract; it still ran inside a
    // transaction of its own, leaving a PostgreSQL session idle in
    // transaction and a pooled connection held for the whole round trip.
    let tracked: TrackedStore | undefined;
    const depthAtStreamTime: number[] = [];
    const openedBeforeStream: number[] = [];
    const { app, store, dispatcher } = await setupHosted(
      hostedStreamFn(
        [
          fauxAssistantMessage([fauxToolCall('get_project_status', {})]),
          fauxAssistantMessage([
            fauxToolCall('submit_recommendation', validRecommendationArgs),
          ]),
        ],
        () => {
          depthAtStreamTime.push(tracked?.openDepth() ?? -1);
          openedBeforeStream.push(tracked?.opened() ?? -1);
        },
      ),
      {
        wrapStore: (inner) => {
          tracked = trackTransactions(inner);
          return tracked.store;
        },
      },
    );
    const projectId = await createProject(app, 'deferred-no-txn');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);

    // Two turns, and no transaction was open during either of them.
    expect(depthAtStreamTime).toEqual([0, 0]);
    // The read tool between them still reached the database -- in a short
    // transaction of its own, opened and committed between the two turns.
    const [firstTurn, secondTurn] = openedBeforeStream;
    expect(secondTurn).toBeGreaterThan(firstTurn as number);
    expect(
      (await recommendations(store, projectId))[0]?.recommendationCode,
    ).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('records a failure metric and stays silent-free when the deferred run cannot persist', async () => {
    // Finding 4. The design deliberately leaves the run 'running' with nothing
    // to retry, so this counter is the only signal that a finding was lost:
    // there is no logger here, BufferedSpan.setStatus drops the error object,
    // and with no OTLP endpoint no span is exported at all.
    const metrics = new MetricsRegistry();
    let tracked: TrackedStore | undefined;
    const { app, store, dispatcher } = await setupHosted(
      hostedStreamFn(
        [
          fauxAssistantMessage([
            fauxToolCall('submit_recommendation', validRecommendationArgs),
          ]),
        ],
        // The next transaction after the model call is the one that persists.
        () => {
          if (tracked) tracked.failNextTransaction = true;
        },
      ),
      {
        metrics,
        wrapStore: (inner) => {
          tracked = trackTransactions(inner);
          return tracked.store;
        },
      },
    );
    const projectId = await createProject(app, 'deferred-persist-fails');
    await drain(dispatcher);
    const event = await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
    });

    // afterCommit must not throw, whatever happens inside it.
    await expect(dispatcher.pollOnce()).resolves.toBe(true);

    expect(await recommendations(store, projectId)).toEqual([]);
    const run = await store.withTransaction((repositories) =>
      repositories.agentRuns.findById(DEV_TENANT_ID, event.id),
    );
    expect(run?.status).toBe('running'); // visibly stuck, as designed
    expect(
      metrics
        .snapshot()
        .find(
          (entry) =>
            entry.name === 'pi_agent_runs_total' &&
            entry.labels.status === 'failure' &&
            entry.labels.run_type === 'operator',
        )?.value,
    ).toBe(1);
  });

  it('continues the trigger event trace into the deferred run span', async () => {
    const traceId = 'a'.repeat(32);
    const { app, store, telemetry, dispatcher } = await setupHosted(
      hostedStreamFn([
        fauxAssistantMessage([
          fauxToolCall('submit_recommendation', validRecommendationArgs),
        ]),
      ]),
    );
    const projectId = await createProject(app, 'deferred-trace');
    await drain(dispatcher);
    await appendEvent(store, {
      projectId,
      type: 'executor.unavailable',
      traceId,
    });

    expect(await dispatcher.pollOnce()).toBe(true);
    const deferred = telemetry
      .getSpans()
      .find((span) => span.name === 'operator.deferred_run');
    // Without this the deferred work detaches from the trigger's trace, unlike
    // every other operator span.
    expect(deferred?.traceId).toBe(traceId);
    expect(deferred?.attributes.result).toBe('success');
  });

  it('stops a run that keeps calling tools once it has spent its budget', async () => {
    // Pi ends the loop when the model stops calling tools and has no iteration
    // cap of its own, so an unbounded caller is bounded only by the wall clock.
    // Bound the spend instead, which is what the risk actually is. The limit is
    // set to 1 token so the assertion does not depend on faux's token estimate.
    const turns: number[] = [];
    const readCall = () =>
      fauxAssistantMessage([fauxToolCall('get_project_status', {})]);
    const { app, store, telemetry, dispatcher } = await setupHosted(
      hostedStreamFn(
        [
          readCall(),
          readCall(),
          readCall(),
          readCall(),
          readCall(),
          readCall(),
        ],
        () => turns.push(1),
      ),
      { maxRunTokens: 1 },
    );
    const projectId = await createProject(app, 'deferred-budget-cap');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);

    // One turn, not the six the stub scripted.
    expect(turns).toHaveLength(1);
    const exhausted = telemetry
      .getSpans()
      .flatMap((span) => span.events)
      .filter((candidate) => candidate.name === 'run.budget_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.attributes.outcome).toBe('tokens');
    expect(exhausted[0]?.attributes.max).toBe(1);
    // The model never submitted, so the finding is the documented fallback.
    expect((await recommendations(store, projectId))[0]?.title).toBe(
      'Wait for the executor to recover',
    );
  });

  it('runs every turn the model asks for when no budget is configured', async () => {
    // The counterpart to the case above: the bound must not fire on its own.
    // faux reports no cost at all, so a cost-only ceiling would never engage --
    // which is why the token limit exists next to it.
    const turns: number[] = [];
    const readCall = () =>
      fauxAssistantMessage([fauxToolCall('get_project_status', {})]);
    const { app, store, telemetry, dispatcher } = await setupHosted(
      hostedStreamFn([readCall(), readCall(), readCall()], () => turns.push(1)),
      { maxRunCostMicrousd: 0, maxRunTokens: 0 },
    );
    const projectId = await createProject(app, 'deferred-no-cap');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);

    expect(turns.length).toBeGreaterThanOrEqual(3);
    expect(
      telemetry
        .getSpans()
        .flatMap((span) => span.events)
        .filter((candidate) => candidate.name === 'run.budget_exhausted'),
    ).toHaveLength(0);
  });
});

describe('Phase 7E step 3 follow-up: W4 -- a captured conclusion survives the bound', () => {
  /**
   * A finding the model actually reached is not the operator's to throw
   * away. Before W4 every one of these persisted `defaultOutput()` and
   * recorded the run as `failed`, which reads from the outside exactly like
   * a model that never answered.
   *
   * Each case submits batched with a read call, so the batch does not
   * terminate (`agent-loop.js:376`) and the run is still going when the
   * bound arrives -- which is the only way to reach these paths at all.
   */
  const submitThenRead = () =>
    fauxAssistantMessage([
      fauxToolCall('submit_recommendation', modelAuthoredArgs),
      fauxToolCall('get_project_status', {}),
    ]);

  async function expectRescued(
    store: ReturnType<typeof createInMemoryStore>,
    telemetry: InMemoryTelemetry,
    projectId: Uuid,
    outcome: string,
  ): Promise<void> {
    const recommendation = (await recommendations(store, projectId))[0];
    if (!recommendation) throw new Error('Expected a persisted finding.');
    expect(recommendation).toMatchObject({
      severity: 'info',
      title: 'Model authored title',
      proposedActionType: 'no_action',
    });
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs[0]).toMatchObject({ status: 'succeeded' });
    expect(runs[0]?.failureCode ?? undefined).toBeUndefined();
    // The bound still happened, and still says so.
    const runSpan = telemetry
      .getSpans()
      .find((span) => span.name === 'agent.operator.run');
    expect(runSpan?.attributes.outcome).toBe(outcome);
    expect(runSpan?.attributes.result).toBe('submitted');
  }

  it('keeps the finding when the run times out after the model submitted', async () => {
    // The second stream call outlives the run timeout, so `timedOut` is set
    // with a submission already captured.
    const responses = [submitThenRead(), fauxAssistantMessage('Still going.')];
    const inner = hostedStreamFn(responses);
    let call = 0;
    const streamFn: StreamFn = async (model, context, options) => {
      call += 1;
      if (call > 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return inner(model, context, options);
    };
    const { app, store, telemetry, dispatcher } = await setupHosted(streamFn, {
      timeoutMs: 100,
    });
    const projectId = await createProject(app, 'w4-timeout');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);
    await expectRescued(store, telemetry, projectId, 'timed_out');
  });

  it('keeps the finding when a later turn comes back a provider error', async () => {
    const { app, store, telemetry, dispatcher } = await setupHosted(
      hostedStreamFn([
        submitThenRead(),
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'simulated provider failure',
        }),
      ]),
    );
    const projectId = await createProject(app, 'w4-provider-error');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);
    await expectRescued(store, telemetry, projectId, 'provider_error');
  });

  it('keeps the finding when the budget runs out after the model submitted', async () => {
    // Guards what W1 already made true: the budget bound stops the loop at a
    // turn boundary, and the conclusion reached before it still stands.
    const { app, store, telemetry, dispatcher } = await setupHosted(
      hostedStreamFn([
        submitThenRead(),
        fauxAssistantMessage([fauxToolCall('get_project_status', {})]),
      ]),
      { maxRunTokens: 1 },
    );
    const projectId = await createProject(app, 'w4-budget');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);
    await expectRescued(store, telemetry, projectId, 'budget_exhausted');
  });

  it('still fails when the bound arrives before the model submitted anything', async () => {
    // The negative control: the rescue is conditional on a real capture, not
    // a blanket downgrade of every timeout to a success.
    const metrics = new MetricsRegistry();
    const inner = hostedStreamFn([
      fauxAssistantMessage([fauxToolCall('get_project_status', {})]),
      fauxAssistantMessage('Still going.'),
    ]);
    let call = 0;
    const streamFn: StreamFn = async (model, context, options) => {
      call += 1;
      if (call > 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return inner(model, context, options);
    };
    const { app, store, dispatcher } = await setupHosted(streamFn, {
      timeoutMs: 100,
      metrics,
    });
    const projectId = await createProject(app, 'w4-timeout-no-finding');
    await drain(dispatcher);
    await appendEvent(store, { projectId, type: 'executor.unavailable' });

    expect(await dispatcher.pollOnce()).toBe(true);
    expect((await recommendations(store, projectId))[0]).toMatchObject({
      title: 'Wait for the executor to recover',
      severity: 'critical',
    });
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
    );
    expect(runs[0]).toMatchObject({ status: 'failed', failureCode: 'TIMEOUT' });
    // W5: a run that never got as far as a tier reports `error`, not silence.
    expect(
      metrics
        .snapshot()
        .find((entry) => entry.name === 'video_operator_output_tier_total')
        ?.labels.tier,
    ).toBe('error');
  });
});

describe('safeRecommendationText', () => {
  /**
   * These are the sentences a real model writes. Every one of them was
   * mangled before the rules demanded evidence of the real thing -- which
   * went unnoticed for as long as tier 1 rarely worked, because
   * `defaultOutput()`'s fixed strings contain no slashes and never say
   * "prompt".
   */
  it.each([
    'The attempt failed 3/5 times before the executor became unavailable.',
    'Retry and/or escalate to a human reviewer.',
    'Queue depth was N/A at the time of the failure.',
    'The executor reported COMFY_UNAVAILABLE at 12/05 14:03 UTC.',
    'Throughput dropped to 2 frames/second during the run.',
    'The prompt was rejected by the validator.',
    'Check the input/output ratio, then decide.',
  ])('leaves ordinary prose alone: %s', (prose) => {
    expect(safeRecommendationText(prose, 'fallback')).toBe(prose);
  });

  it.each([
    ['an absolute path', 'Wrote /private/tmp/h3/out.mp4 then failed.'],
    ['a home path', 'Config at ~/.config/h3/settings.json is stale.'],
    ['a Windows path', String.raw`Wrote C:\Users\op\out.mp4 then failed.`],
    [
      'a signed URL',
      'Fetched https://example.com/a.mp4?sig=abc123 and failed.',
    ],
    ['a non-http scheme', 'Object s3://bucket/key.mp4 is missing.'],
  ])('still redacts %s', (_label, text) => {
    const sanitized = safeRecommendationText(text, 'fallback');
    expect(sanitized).toMatch(/\[(?:path|url) redacted\]/);
    // Nothing of the location survives.
    expect(sanitized).not.toMatch(/mp4|settings\.json|sig=|bucket/);
  });

  it('redacts prompt content behind an assignment, in either shape', () => {
    expect(
      safeRecommendationText('prompt: a cinematic shot of a cat', 'fallback'),
    ).toBe('[prompt redacted]');
    expect(
      safeRecommendationText('raw prompt = a cinematic shot', 'fallback'),
    ).toBe('[prompt redacted]');
    expect(
      safeRecommendationText('{"prompt": "a cinematic shot"}', 'fallback'),
    ).not.toContain('cinematic');
  });

  it('redacts credentials, and falls back when nothing survives', () => {
    expect(safeRecommendationText('api_key: sk-abc123', 'fallback')).toBe(
      '[credential redacted]',
    );
    expect(
      safeRecommendationText('Authorized with Bearer abc.def-123', 'fallback'),
    ).toBe('Authorized with Bearer [redacted]');
    expect(safeRecommendationText('   ', 'fallback')).toBe('fallback');
  });
});
