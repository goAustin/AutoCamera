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
  type AgentRunRecord,
  type TransactionalStore,
} from '@h3/db';
import {
  OPERATIONAL_DIGEST_TOOL_NAME,
  OPERATIONAL_TOOL_NAMES,
} from '@h3/agent-tools';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import { InMemoryTelemetry } from '@h3/telemetry';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { buildApiApp } from './app.js';
import { DEV_TENANT_ID } from './application.js';
import { OperationalDigestService } from './digest.js';
import { createOperationalToolServices } from './operator.js';

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

const WINDOW = {
  sinceIso: '2026-01-01T00:00:00.000Z',
  untilIso: '2026-01-01T23:59:59.000Z',
} as const;

/** The same throwaway-faux stub the operator tests use for a non-faux provider. */
function hostedStreamFn(responses: readonly FauxResponseStep[]): StreamFn {
  const faux = fauxProvider({
    provider: 'deepseek-test-stub',
    models: [{ id: 'stub-model', name: 'stub-model' }],
  });
  faux.setResponses([...responses]);
  return (model, context, options) =>
    faux.provider.streamSimple(model, context, options);
}

interface DigestFixture {
  readonly app: Awaited<ReturnType<typeof buildApiApp>>;
  readonly store: TransactionalStore;
  readonly telemetry: InMemoryTelemetry;
}

function setup(): DigestFixture {
  const store = createInMemoryStore();
  const telemetry = new InMemoryTelemetry();
  const app = buildApiApp({
    store,
    telemetry,
    idGenerator: testIds(),
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-token' }),
    comfyClient: new FakeComfyClient(new DeterministicFakeComfyService()),
  });
  apps.push(app);
  return { app, store, telemetry };
}

function digestService(
  fixture: DigestFixture,
  overrides: Partial<{
    readonly provider: string;
    readonly streamFnOverride: StreamFn;
    readonly timeoutMs: number;
  }> = {},
): OperationalDigestService {
  return new OperationalDigestService({
    store: fixture.store,
    tenantId: DEV_TENANT_ID,
    idGenerator: testIds(),
    telemetry: fixture.telemetry,
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
    ...overrides,
  });
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  prefix: string,
): Promise<Uuid> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { ...auth, 'idempotency-key': `${prefix}-project` },
    payload: {
      title: `${prefix} project`,
      brief: 'A project for session digest tests.',
      targetDurationSeconds: 3,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id as Uuid;
}

async function appendIncident(
  store: TransactionalStore,
  input: {
    readonly projectId: Uuid;
    readonly type: DomainEvent['type'];
    readonly attemptId?: Uuid;
    readonly occurredAt?: string;
  },
): Promise<DomainEvent> {
  const event = createDomainEvent({
    id: testId(),
    type: input.type,
    producer: 'digest-test',
    tenantId: DEV_TENANT_ID,
    projectId: input.projectId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    payload: { status: 'FAILED' },
    clock: {
      now: () => new Date(input.occurredAt ?? '2026-01-01T06:00:00.000Z'),
    },
  });
  await store.withTransaction((repositories) =>
    repositories.events.append(event),
  );
  return event;
}

/**
 * Records the open-transaction depth at every provider call rather than the
 * last one: a single-observation version passes even when one call in the
 * middle held a transaction open (the caveat the phase doc records against
 * the equivalent webhook test).
 */
function trackTransactions(inner: TransactionalStore): {
  readonly store: TransactionalStore;
  readonly openDepth: () => number;
} {
  let depth = 0;
  return {
    store: {
      withTransaction: async (work) => {
        depth += 1;
        try {
          return await inner.withTransaction(work);
        } finally {
          depth -= 1;
        }
      },
    },
    openDepth: () => depth,
  };
}

async function agentRunsFor(
  store: TransactionalStore,
  projectId: Uuid,
): Promise<readonly AgentRunRecord[]> {
  return store.withTransaction((repositories) =>
    repositories.agentRuns.listByProject(DEV_TENANT_ID, projectId),
  );
}

async function eventTypesFor(
  store: TransactionalStore,
  projectId: Uuid,
): Promise<readonly string[]> {
  const events = await store.withTransaction((repositories) =>
    repositories.events.listByProject(projectId),
  );
  return events.map((event) => event.type);
}

describe('Phase 7E step 4 session digest', () => {
  it('produces one bounded validated digest through the six read tools', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-faux');
    const attemptId = testId();
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId,
    });

    const outcome = await digestService(fixture).createDigest(
      projectId,
      WINDOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.digest).toMatchObject({
      severity: 'warning',
      referencedRunIds: [attemptId],
      sinceIso: WINDOW.sinceIso,
      untilIso: WINDOW.untilIso,
    });
    expect(outcome.digest.title.length).toBeLessThanOrEqual(240);
    expect(outcome.digest.detail.length).toBeLessThanOrEqual(2_000);
    expect(outcome.agentRun.status).toBe('succeeded');
    expect(outcome.agentRun.toolCalls).toBeGreaterThan(0);
  });

  it('persists exactly one agent_runs row and writes nothing else', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-one-run');
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: testId(),
    });
    const eventsBefore = await eventTypesFor(fixture.store, projectId);

    const outcome = await digestService(fixture).createDigest(
      projectId,
      WINDOW,
    );
    expect(outcome.ok).toBe(true);

    const runs = await agentRunsFor(fixture.store, projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');
    // A digest narrates; it must leave the record it read exactly as it was.
    expect(await eventTypesFor(fixture.store, projectId)).toEqual(eventsBefore);
    const recommendations = await fixture.store.withTransaction(
      (repositories) =>
        repositories.operationalRecommendations.listByProject(
          DEV_TENANT_ID,
          projectId,
        ),
    );
    expect(recommendations).toEqual([]);
  });

  it('offers six read tools and one submission tool, and no write tool', () => {
    expect(OPERATIONAL_TOOL_NAMES).toHaveLength(6);
    expect([...OPERATIONAL_TOOL_NAMES]).not.toContain(
      OPERATIONAL_DIGEST_TOOL_NAME,
    );
    expect(
      [...OPERATIONAL_TOOL_NAMES].every((name) => name.startsWith('get_')),
    ).toBe(true);
  });

  it('bounds the evidence to the window rather than the project', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-window');
    const inWindow = testId();
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: inWindow,
      occurredAt: '2026-01-01T06:00:00.000Z',
    });
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: testId(),
      // A day later: the same project, outside the rented session.
      occurredAt: '2026-01-02T06:00:00.000Z',
    });

    const outcome = await digestService(fixture).createDigest(
      projectId,
      WINDOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.digest.referencedRunIds).toEqual([inWindow]);
    expect(outcome.digest.title).toContain('1 incident');
  });

  it('denies a run id the window does not contain', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-scope');
    const inWindow = testId();
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: inWindow,
    });
    const fabricated = testId();

    const outcome = await digestService(fixture, {
      provider: 'deepseek-test-stub',
      streamFnOverride: hostedStreamFn([
        fauxAssistantMessage([
          fauxToolCall(
            'submit_digest',
            {
              severity: 'warning',
              title: 'One attempt failed during the session.',
              detail: 'The window contains a single failed attempt.',
              referencedRunIds: [inWindow, fabricated],
            },
            { id: 'digest-scope-0' },
          ),
        ]),
      ]),
    }).createDigest(projectId, WINDOW);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The model cited one run it was shown and one it invented; only the
    // first survives.
    expect(outcome.digest.referencedRunIds).toEqual([inWindow]);
  });

  it('degrades to the lookup-table digest when the provider fails', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-degrade');
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: testId(),
    });

    const outcome = await digestService(fixture, {
      provider: 'deepseek-test-stub',
      streamFnOverride: hostedStreamFn([
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'provider exploded',
        }),
      ]),
    }).createDigest(projectId, WINDOW);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.digest.severity).toBe('warning');
    expect(outcome.digest.title).toContain('1 incident');
    expect(outcome.agentRun.status).toBe('failed');
    expect(outcome.agentRun.failureCode).toBe('PROVIDER_ERROR');
  });

  it('calls the provider with no transaction open', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-no-tx');
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: testId(),
    });
    const tracked = trackTransactions(fixture.store);
    const depths: number[] = [];

    const service = new OperationalDigestService({
      store: tracked.store,
      tenantId: DEV_TENANT_ID,
      idGenerator: testIds(),
      telemetry: fixture.telemetry,
      provider: 'deepseek-test-stub',
      streamFnOverride: (model, context, options) => {
        depths.push(tracked.openDepth());
        return hostedStreamFn([
          fauxAssistantMessage([
            fauxToolCall(
              'submit_digest',
              {
                severity: 'info',
                title: 'The session completed without incident.',
                detail: 'Nothing in the window required attention.',
                referencedRunIds: [],
              },
              { id: 'digest-no-tx-0' },
            ),
          ]),
        ])(model, context, options);
      },
      services: (repositories) =>
        createOperationalToolServices(repositories, DEV_TENANT_ID, {
          mode: 'fake',
          getExecutorReadiness: async () => ({
            mode: 'fake',
            ready: true,
            checkedAt: '2026-01-01T00:00:00.000Z',
          }),
        }),
    });

    const outcome = await service.createDigest(projectId, WINDOW);
    expect(outcome.ok).toBe(true);
    expect(depths.length).toBeGreaterThan(0);
    // Every observation, not the last: one call that held a transaction is
    // the defect this is here to catch.
    expect(depths).toEqual(depths.map(() => 0));
  });
});

describe('POST /v1/projects/:projectId/digest', () => {
  it('returns one bounded digest and records its cost against the project', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-route');
    await appendIncident(fixture.store, {
      projectId,
      type: 'attempt.failed',
      attemptId: testId(),
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/digest`,
      headers: { ...auth, 'idempotency-key': 'digest-route-1' },
      payload: { sinceIso: WINDOW.sinceIso, untilIso: WINDOW.untilIso },
    });

    expect(response.statusCode).toBe(200);
    const digest = response.json().digest as Record<string, unknown>;
    expect(digest).toMatchObject({
      severity: 'warning',
      sinceIso: WINDOW.sinceIso,
      untilIso: WINDOW.untilIso,
    });
    expect(String(digest.title).length).toBeLessThanOrEqual(240);
    expect(String(digest.detail).length).toBeLessThanOrEqual(2_000);

    const runs = await agentRunsFor(fixture.store, projectId);
    expect(runs).toHaveLength(1);
    expect(digest.agentRunId).toBe(runs[0]?.id);

    // Step 5's figure now has a digest in it. Asserting the identity rather
    // than a literal zero, which faux would make true for free.
    const cost = await fixture.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: auth,
    });
    expect(cost.json()).toMatchObject({
      spentMicrousd: 0,
      inferenceCostMicrousd: runs[0]?.providerCostMicrousd,
    });
  });

  it('replays one digest for a repeated Idempotency-Key without a second run', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-idempotent');
    const payload = { sinceIso: WINDOW.sinceIso, untilIso: WINDOW.untilIso };
    const headers = { ...auth, 'idempotency-key': 'digest-replay' };

    const first = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/digest`,
      headers,
      payload,
    });
    const second = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/digest`,
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // The replay is what stops a retry buying a second inference call.
    expect(await agentRunsFor(fixture.store, projectId)).toHaveLength(1);
  });

  it('rejects a window that ends before it starts', async () => {
    const fixture = setup();
    const projectId = await createProject(fixture.app, 'digest-backwards');

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/digest`,
      headers: { ...auth, 'idempotency-key': 'digest-backwards-1' },
      payload: { sinceIso: WINDOW.untilIso, untilIso: WINDOW.sinceIso },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('INVALID_REQUEST');
  });

  it('404s for a project that does not exist, and leaves the key reusable', async () => {
    const fixture = setup();
    const missing = testId();
    const headers = { ...auth, 'idempotency-key': 'digest-missing' };
    const payload = { sinceIso: WINDOW.sinceIso, untilIso: WINDOW.untilIso };

    const first = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${missing}/digest`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(404);

    // The reservation was released, so the same key is not wedged.
    const second = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${missing}/digest`,
      headers,
      payload,
    });
    expect(second.statusCode).toBe(404);
  });

  it('reports the digest run as inference spend, never as attempt spend', async () => {
    const fixture = setup();
    const created = await fixture.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'digest-cost-project' },
      payload: {
        title: 'Monitored digest project',
        brief: 'Monitoring cost must stay out of the budget.',
        targetDurationSeconds: 3,
        budgetMicrousd: 50_000,
      },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id as Uuid;

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/digest`,
      headers: { ...auth, 'idempotency-key': 'digest-cost-1' },
      payload: { sinceIso: WINDOW.sinceIso, untilIso: WINDOW.untilIso },
    });
    expect(response.statusCode).toBe(200);

    // The faux provider computes its own usage and always prices it at zero
    // (`providers/faux.js`, `cost: { total: 0 }`), so no offline run can
    // produce a non-zero figure. Pricing the row the digest actually created
    // is what makes the assertion below about wiring rather than about zero:
    // this exact row, five times the whole budget, must land in inference
    // spend and nowhere near the breaker.
    const runs = await agentRunsFor(fixture.store, projectId);
    expect(runs).toHaveLength(1);
    const digestRun = runs[0];
    if (!digestRun) return;
    await fixture.store.withTransaction((repositories) =>
      repositories.agentRuns.update(
        {
          ...digestRun,
          providerCostMicrousd: 250_000,
          version: digestRun.version + 1,
        },
        digestRun.version,
      ),
    );

    const cost = await fixture.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/cost`,
      headers: auth,
    });
    expect(cost.json()).toMatchObject({
      budgetMicrousd: 50_000,
      inferenceCostMicrousd: 250_000,
      spentMicrousd: 0,
      remainingMicrousd: 50_000,
    });
  });
});
