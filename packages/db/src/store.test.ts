import { describe, expect, it } from 'vitest';
import {
  createDomainEvent,
  createUuidV7,
  createVideoProject,
  parseUsdToMicrousd,
} from '@h3/domain';
import { createInMemoryStore, OutboxDispatcher } from './index.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const clock = { now: () => new Date(timestamp) };
const id = (seed: number) =>
  createUuidV7(1_700_000_000_000 + seed, new Uint8Array(10).fill(seed));

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
});
