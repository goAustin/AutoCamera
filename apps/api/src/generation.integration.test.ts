import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  parseUsdToMicrousd,
  systemIdGenerator,
  toIsoUtc,
  transitionGenerationAttempt,
  type GenerationAttempt,
  type Uuid,
} from '@h3/domain';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  runMigrations,
} from '@h3/db';
import {
  DeterministicFakeComfyService,
  FakeComfyClient,
} from '@h3/comfy-client';
import {
  DeterministicFixtureProcessRunner,
  MediaEvaluator,
} from '@h3/evaluator';
import { createLocalArtifactStore } from '@h3/object-store';
import { DEV_TENANT_ID, ProjectApplicationService } from './application.js';
import {
  GenerationApplicationService,
  GenerationWorker,
} from './generation.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const controlPool = createDatabasePool(databaseUrl);
const databaseAvailable = await checkDatabaseReady(controlPool);
const schemaName = `h3_phase5_gate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
if (databaseAvailable) {
  await controlPool.query(`CREATE SCHEMA "${schemaName}"`);
}
const pool = databaseAvailable
  ? createDatabasePool(databaseUrl, { searchPath: schemaName })
  : controlPool;
const store = createPostgresStore(pool);
const roots: string[] = [];

interface GenerationContext {
  readonly projectService: ProjectApplicationService;
  readonly generation: GenerationApplicationService;
  readonly comfy: DeterministicFakeComfyService;
  readonly shotId: Uuid;
  readonly now: { value: number };
}

async function setupGeneration(): Promise<GenerationContext> {
  const now = { value: Date.parse('2026-01-01T00:00:00.000Z') };
  const clock = { now: () => new Date(now.value) };
  const projectService = new ProjectApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator: systemIdGenerator,
    clock,
    defaultBudgetMicrousd: parseUsdToMicrousd('25'),
  });
  const project = await projectService.createProject({
    title: `PostgreSQL recovery ${now.value}-${Math.random()}`,
    brief: 'A durable worker recovery integration test.',
    targetDurationSeconds: 3,
    budgetMicrousd: parseUsdToMicrousd('25'),
  });
  const planned = await projectService.planProject(project.id);
  const approved = await projectService.approveStoryboard(
    project.id,
    planned.proposal.id,
  );
  const root = await mkdtemp(join(tmpdir(), 'h3-generation-integration-'));
  roots.push(root);
  const comfy = new DeterministicFakeComfyService();
  const generation = new GenerationApplicationService({
    store,
    tenantId: DEV_TENANT_ID,
    idGenerator: systemIdGenerator,
    clock,
    comfyClient: new FakeComfyClient(comfy),
    artifactStore: createLocalArtifactStore(root),
    evaluator: new MediaEvaluator(new DeterministicFixtureProcessRunner()),
  });
  const shot = approved.shots[0];
  if (!shot) throw new Error('Expected one approved shot.');
  return { projectService, generation, comfy, shotId: shot.id, now };
}

function leaseTime(context: GenerationContext, seconds: number): string {
  return toIsoUtc(new Date(context.now.value + seconds * 1000));
}

async function createAttempt(
  context: GenerationContext,
  suffix: string,
  scenario?:
    | 'success'
    | 'duplicate-events'
    | 'disconnect-reconcile'
    | 'execution-failure'
    | 'timeout'
    | 'uncertain-submission',
): Promise<GenerationAttempt> {
  return context.generation.createAttempt(context.shotId, {
    idempotencyKey: `pg-recovery-${suffix}-${Date.now()}-${Math.random()}`,
    ...(scenario ? { scenario } : {}),
  });
}

beforeAll(async () => {
  if (databaseAvailable) await runMigrations(pool);
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await closeDatabase(pool);
  if (databaseAvailable) {
    await controlPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  }
  if (pool !== controlPool) await closeDatabase(controlPool);
});

describe.skipIf(!databaseAvailable)(
  'PostgreSQL worker restart and reconciliation',
  () => {
    it('reclaims a lease after a simulated process crash and completes once', async () => {
      const context = await setupGeneration();
      const attempt = await createAttempt(context, 'lease-restart');
      const claimed = await store.withTransaction((repositories) =>
        repositories.attempts.claimNext(
          'crashed-worker',
          leaseTime(context, 0),
          leaseTime(context, 1),
        ),
      );
      expect(claimed).toMatchObject({
        id: attempt.id,
        status: 'claimed',
        leaseOwner: 'crashed-worker',
      });

      context.now.value += 2_000;
      const restarted = new GenerationWorker({
        service: context.generation,
        workerId: 'restarted-worker',
        leaseSeconds: 1,
        timeoutSeconds: 2,
        sleep: async () => undefined,
      });
      await expect(restarted.processOnce()).resolves.toBe(true);

      const result = await context.generation.getAttempt(attempt.id);
      expect(result.status).toBe('awaiting_review');
      expect(result.leaseOwner).toBeUndefined();
      expect(context.comfy.submissionCount(attempt.correlationId)).toBe(1);
      expect(
        await context.generation.listAttempts(context.shotId),
      ).toHaveLength(1);
    });

    it('allows only one concurrent PostgreSQL lease and reclaims it after expiry', async () => {
      const context = await setupGeneration();
      const attempt = await createAttempt(context, 'concurrent-lease');
      const claims = await Promise.all(
        ['lease-worker-a', 'lease-worker-b'].map((workerId) =>
          store.withTransaction((repositories) =>
            repositories.attempts.claimNext(
              workerId,
              leaseTime(context, 0),
              leaseTime(context, 1),
            ),
          ),
        ),
      );
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      const owner = claims.find((claim) => claim !== null)?.leaseOwner;
      expect(owner).toBeDefined();

      context.now.value += 2_000;
      await store.withTransaction((repositories) =>
        repositories.attempts.recoverStale(leaseTime(context, 0)),
      );
      const reclaimed = await store.withTransaction((repositories) =>
        repositories.attempts.claimNext(
          'lease-worker-recovered',
          leaseTime(context, 0),
          leaseTime(context, 1),
        ),
      );
      expect(reclaimed).toMatchObject({
        id: attempt.id,
        leaseOwner: 'lease-worker-recovered',
      });
    });

    it('reconciles an accepted-but-unpersisted uncertain submission by correlation', async () => {
      const context = await setupGeneration();
      const attempt = await createAttempt(
        context,
        'uncertain',
        'uncertain-submission',
      );
      expect(() =>
        context.comfy.submit({
          workflow: {},
          extraData: {
            correlation_id: attempt.correlationId,
            seed: attempt.seed,
            scenario: 'uncertain-submission',
          },
          scenario: 'uncertain-submission',
          seed: attempt.seed,
        }),
      ).toThrow('ComfyUI submission outcome is uncertain.');

      await store.withTransaction(async (repositories) => {
        const current = await repositories.attempts.findById(
          DEV_TENANT_ID,
          attempt.id,
        );
        if (!current) throw new Error('Attempt disappeared before recovery.');
        const claimed = transitionGenerationAttempt(current, 'claimed');
        const submitting = transitionGenerationAttempt(claimed, 'submitting');
        await repositories.attempts.update(
          {
            ...submitting,
            leaseOwner: 'crashed-submitter',
            leaseExpiresAt: leaseTime(context, -1) as NonNullable<
              GenerationAttempt['leaseExpiresAt']
            >,
          },
          current.version,
        );
      });

      context.now.value += 2_000;
      const restarted = new GenerationWorker({
        service: context.generation,
        workerId: 'reconciler-worker',
        leaseSeconds: 1,
        timeoutSeconds: 2,
        sleep: async () => undefined,
      });
      await expect(restarted.processOnce()).resolves.toBe(true);
      expect((await context.generation.getAttempt(attempt.id)).status).toBe(
        'awaiting_review',
      );
      expect(context.comfy.submissionCount(attempt.correlationId)).toBe(1);
    });

    it('reconciles a WebSocket disconnect and duplicate terminal events idempotently', async () => {
      for (const [suffix, scenario] of [
        ['disconnect', 'disconnect-reconcile'],
        ['duplicate', 'duplicate-events'],
      ] as const) {
        const context = await setupGeneration();
        const attempt = await createAttempt(context, suffix, scenario);
        const worker = new GenerationWorker({
          service: context.generation,
          workerId: `reconcile-${suffix}`,
          timeoutSeconds: 2,
          sleep: async () => undefined,
        });
        await expect(worker.processOnce()).resolves.toBe(true);
        const secondResult = await worker.processOnce();
        const current = await context.generation.getAttempt(attempt.id);
        expect(secondResult).toBe(false);
        expect(current.status).toBe('awaiting_review');
        expect(context.comfy.submissionCount(attempt.correlationId)).toBe(1);
        const counts = await pool.query<{
          artifacts: number;
          evaluations: number;
        }>(
          `SELECT
           (SELECT count(*)::int FROM artifacts WHERE attempt_id = $1) AS artifacts,
           (SELECT count(*)::int FROM evaluation_results WHERE attempt_id = $1) AS evaluations`,
          [attempt.id],
        );
        expect(counts.rows[0]).toEqual({ artifacts: 1, evaluations: 1 });
      }
    });
  },
);
