import { describe, expect, it } from 'vitest';
import {
  createDomainEvent,
  createGenerationAttempt,
  createUuidV7,
  createVideoProject,
  parseUsdToMicrousd,
  type GenerationAttempt,
} from '@h3/domain';
import {
  createInMemoryStore,
  OutboxDispatcher,
  RepositoryError,
} from './index.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const clock = { now: () => new Date(timestamp) };
const id = (seed: number) =>
  createUuidV7(1_700_000_000_000 + seed, new Uint8Array(10).fill(seed));

function attempt(seed: number): GenerationAttempt {
  return createGenerationAttempt({
    id: id(10 + seed),
    tenantId: id(2),
    projectId: id(3),
    shotId: id(4 + seed),
    idempotencyKey: `attempt-${seed}`,
    seed,
    steps: 8,
    requestedWidth: 960,
    requestedHeight: 544,
    requestedDurationSeconds: 5,
    workflowHash: `workflow-${seed}`,
    correlationId: `correlation-${seed}`,
    estimatedCostMicrousd: 100_000,
    now: timestamp,
  });
}

function project() {
  return createVideoProject({
    id: id(1),
    tenantId: id(2),
    title: 'Atomic project',
    brief: 'A transaction test.',
    targetDurationSeconds: 3,
    budgetMicrousd: parseUsdToMicrousd('5'),
    now: timestamp,
  });
}

describe('transactional in-memory repository contract', () => {
  it('rolls back state, event, and outbox together', async () => {
    const store = createInMemoryStore();
    const value = project();
    const event = createDomainEvent({
      id: id(3),
      type: 'project.created',
      producer: 'test',
      tenantId: value.tenantId,
      projectId: value.id,
      clock,
      payload: { status: 'draft' },
    });

    await expect(
      store.withTransaction(async (repositories) => {
        await repositories.tenants.ensure(value.tenantId, 'Test', timestamp);
        await repositories.projects.create(value);
        await repositories.events.append(event);
        await repositories.outbox.enqueue(event);
        throw new Error('rollback sentinel');
      }),
    ).rejects.toThrow('rollback sentinel');

    await store.withTransaction(async (repositories) => {
      expect(await repositories.projects.listByTenant(value.tenantId)).toEqual(
        [],
      );
      expect(await repositories.events.listByProject(value.id)).toEqual([]);
    });
  });

  it('commits an event and delivers its outbox record exactly once', async () => {
    const store = createInMemoryStore();
    const value = project();
    const event = createDomainEvent({
      id: id(4),
      type: 'project.created',
      producer: 'test',
      tenantId: value.tenantId,
      projectId: value.id,
      clock,
      payload: { status: 'draft' },
    });
    await store.withTransaction(async (repositories) => {
      await repositories.tenants.ensure(value.tenantId, 'Test', timestamp);
      await repositories.projects.create(value);
      await repositories.events.append(event);
      await repositories.outbox.enqueue(event);
    });

    const dispatcher = new OutboxDispatcher(store, undefined, clock);
    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await dispatcher.pollOnce()).toBe(false);
    await store.withTransaction(async (repositories) => {
      expect(await repositories.events.listByProject(value.id)).toHaveLength(1);
    });
  });

  it('claims queued attempts transactionally without duplicate ownership', async () => {
    const store = createInMemoryStore();
    const values = [attempt(1), attempt(2)];
    await store.withTransaction(async (repositories) => {
      for (const value of values) await repositories.attempts.create(value);
    });

    const claimed = await Promise.all(
      ['worker-a', 'worker-b'].map((workerId) =>
        store.withTransaction((repositories) =>
          repositories.attempts.claimNext(
            workerId,
            timestamp,
            '2026-01-01T00:01:00.000Z',
          ),
        ),
      ),
    );
    const claimedIds = claimed.filter((value): value is GenerationAttempt =>
      Boolean(value),
    );
    expect(claimedIds).toHaveLength(2);
    expect(new Set(claimedIds.map((value) => value.id)).size).toBe(2);

    const sameWorker = await store.withTransaction((repositories) =>
      repositories.attempts.claimNext(
        'worker-a',
        timestamp,
        '2026-01-01T00:01:00.000Z',
      ),
    );
    expect(sameWorker).toBeNull();
  });

  it('reclaims expired leases while preserving healthy leases', async () => {
    const store = createInMemoryStore();
    await store.withTransaction(async (repositories) => {
      await repositories.attempts.create(attempt(3));
      await repositories.attempts.create(attempt(4));
    });
    const expired = await store.withTransaction((repositories) =>
      repositories.attempts.claimNext(
        'expired-worker',
        timestamp,
        '2026-01-01T00:00:01.000Z',
      ),
    );
    const healthy = await store.withTransaction((repositories) =>
      repositories.attempts.claimNext(
        'healthy-worker',
        timestamp,
        '2026-01-01T01:00:00.000Z',
      ),
    );
    const recovered = await store.withTransaction((repositories) =>
      repositories.attempts.recoverStale('2026-01-01T00:00:02.000Z'),
    );

    expect(expired?.id).toBeDefined();
    expect(healthy?.id).toBeDefined();
    expect(recovered.map((value) => value.id)).toEqual([expired?.id]);
    await store.withTransaction(async (repositories) => {
      const reclaimed = await repositories.attempts.findById(
        id(2),
        expired?.id as GenerationAttempt['id'],
      );
      const stillHealthy = await repositories.attempts.findById(
        id(2),
        healthy?.id as GenerationAttempt['id'],
      );
      expect(reclaimed?.status).toBe('queued');
      expect(reclaimed?.leaseOwner).toBeUndefined();
      expect(stillHealthy?.status).toBe('claimed');
      expect(stillHealthy?.leaseOwner).toBe('healthy-worker');
    });
  });

  it('releases a live claim back to the queue and enforces correlation uniqueness', async () => {
    const store = createInMemoryStore();
    await store.withTransaction(async (repositories) => {
      await repositories.attempts.create(attempt(5));
      await expect(
        repositories.attempts.create({
          ...attempt(6),
          correlationId: 'correlation-5',
        }),
      ).rejects.toBeInstanceOf(RepositoryError);
    });
    const claimed = await store.withTransaction((repositories) =>
      repositories.attempts.claimNext(
        'release-worker',
        timestamp,
        '2026-01-01T00:01:00.000Z',
      ),
    );
    const released = await store.withTransaction((repositories) =>
      repositories.attempts.release(
        claimed?.id as GenerationAttempt['id'],
        'release-worker',
        '2026-01-01T00:00:02.000Z',
      ),
    );
    expect(released?.status).toBe('queued');
    expect(released?.leaseOwner).toBeUndefined();
  });
});
