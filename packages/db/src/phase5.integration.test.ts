import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDomainEvent,
  createGenerationAttempt,
  createShot,
  createStoryboardProposal,
  createUuidV7,
  createVideoProject,
  parseUsdToMicrousd,
  type GenerationAttempt,
  type Shot,
  type Uuid,
} from '@h3/domain';
import {
  checkDatabaseReady,
  closeDatabase,
  createDatabasePool,
  createPostgresStore,
  hashWorkflowExecutionEnvelope,
  runMigrations,
  type OperationalRecommendationRecord,
  type WorkflowDraftRecord,
  type WorkflowRevisionRecord,
} from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops';
const pool = createDatabasePool(databaseUrl);
const store = createPostgresStore(pool);
const databaseAvailable = await checkDatabaseReady(pool);
let sequence = 1;

function id(): Uuid {
  const value = sequence++;
  return createUuidV7(
    Date.now() + value,
    new Uint8Array(10).fill((value % 250) + 1),
  );
}

const timestamp = '2026-01-01T00:00:00.000Z';

interface SeededProject {
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly proposalId: Uuid;
  readonly shot: Shot;
}

async function seedProject(): Promise<SeededProject> {
  const tenantId = id();
  const project = createVideoProject({
    id: id(),
    tenantId,
    title: 'PostgreSQL Phase 5 project',
    brief: 'A structured persistence integration test.',
    targetDurationSeconds: 3,
    budgetMicrousd: parseUsdToMicrousd('25'),
    now: timestamp,
  });
  const proposal = createStoryboardProposal({
    id: id(),
    projectId: project.id,
    revision: 1,
    shots: [1, 2, 3].map((ordinal) => ({
      ordinal: ordinal as 1 | 2 | 3,
      purpose: `Purpose ${ordinal}`,
      prompt: `Prompt ${ordinal}`,
      durationSeconds: 1,
      mode: 't2v' as const,
      qualityTier: 'preview' as const,
      visualDescription: `Visual ${ordinal}`,
      cameraDirection: `Camera ${ordinal}`,
      audioDirection: `Audio ${ordinal}`,
      acceptanceCriteria: [`Criterion ${ordinal}`],
      requiredAssetIds: [],
    })),
    now: timestamp,
  });
  const definition = proposal.shots[0];
  if (!definition) throw new Error('Expected a shot definition.');
  const shot = createShot({
    id: id(),
    projectId: project.id,
    storyboardProposalId: proposal.id,
    definition,
    now: timestamp,
  });
  await store.withTransaction(async (repositories) => {
    await repositories.tenants.ensure(
      tenantId,
      'Phase 5 test tenant',
      timestamp,
    );
    await repositories.projects.create(project);
    await repositories.storyboards.create(proposal);
    await repositories.shots.createMany([shot]);
  });
  return {
    tenantId,
    projectId: project.id,
    proposalId: proposal.id,
    shot,
  };
}

function revisionFor(
  context: SeededProject,
  overrides: Partial<WorkflowRevisionRecord> = {},
): WorkflowRevisionRecord {
  const apiGraphJson = { '1': { class_type: 'Fixture', inputs: { seed: 17 } } };
  const executionParametersJson = { seed: 17, steps: 20 };
  return {
    id: id(),
    tenantId: context.tenantId,
    projectId: context.projectId,
    shotId: context.shot.id,
    revisionNumber: 1,
    profileId: 'minimax-h3-t2va-preview',
    profileVersion: '1',
    source: 'comfy_editor',
    authorType: 'development_user',
    authorId: 'postgres-test-user',
    editorGraphJson: { nodes: [{ id: 17 }] },
    apiGraphJson,
    executionHash: hashWorkflowExecutionEnvelope({
      profileId: 'minimax-h3-t2va-preview',
      profileVersion: '1',
      apiGraph: apiGraphJson,
      parameters: executionParametersJson,
    }),
    executionParametersJson,
    validationStatus: 'pending',
    validationErrorsJson: [],
    createdAt: timestamp,
    ...overrides,
  };
}

function draftFor(
  context: SeededProject,
  overrides: Partial<WorkflowDraftRecord> = {},
): WorkflowDraftRecord {
  return {
    id: id(),
    tenantId: context.tenantId,
    projectId: context.projectId,
    shotId: context.shot.id,
    profileId: 'minimax-h3-t2va-preview',
    profileVersion: '1',
    editorGraphJson: { nodes: [{ id: 17 }] },
    lastApiGraphJson: { '1': { class_type: 'Fixture' } },
    authorType: 'development_user',
    authorId: 'postgres-test-user',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function recommendationFor(
  context: SeededProject,
  eventId: Uuid,
): OperationalRecommendationRecord {
  return {
    id: id(),
    tenantId: context.tenantId,
    projectId: context.projectId,
    shotId: context.shot.id,
    triggerEventId: eventId,
    severity: 'warning',
    recommendationCode: 'EXECUTOR_UNAVAILABLE',
    title: 'Wait for executor',
    detail: 'Check executor readiness before retrying.',
    evidenceReferencesJson: [{ type: 'domain_event', resourceId: eventId }],
    proposedActionType: 'wait_for_executor',
    proposedResourceIdsJson: [context.shot.id],
    status: 'pending',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

beforeAll(async () => {
  if (databaseAvailable) await runMigrations(pool);
});

afterAll(async () => {
  await closeDatabase(pool);
});

describe.skipIf(!databaseAvailable)('Phase 5 PostgreSQL persistence', () => {
  it('round-trips structured shots, drafts, immutable revisions, managed attempts, and recommendations', async () => {
    const context = await seedProject();
    const draft = draftFor(context);
    const revision = revisionFor(context);
    const event = createDomainEvent({
      id: id(),
      type: 'attempt.failed',
      producer: 'phase5-test',
      tenantId: context.tenantId,
      projectId: context.projectId,
      shotId: context.shot.id,
      clock: { now: () => new Date(timestamp) },
      payload: { code: 'COMFY_UNAVAILABLE' },
    });
    let managedAttempt: GenerationAttempt | undefined;
    let recommendation: OperationalRecommendationRecord | undefined;

    await store.withTransaction(async (repositories) => {
      const storedShot = await repositories.shots.findById(
        context.projectId,
        context.shot.id,
      );
      expect(storedShot).toMatchObject({
        visualDescription: 'Visual 1',
        cameraDirection: 'Camera 1',
        audioDirection: 'Audio 1',
        acceptanceCriteria: ['Criterion 1'],
        requiredAssetIds: [],
      });
      if (!storedShot) throw new Error('Expected persisted shot.');
      const changedShot = {
        ...storedShot,
        visualDescription: 'Updated visual direction',
        version: storedShot.version + 1,
        updatedAt: '2026-01-01T00:00:01.000Z',
      };
      await repositories.shots.update(changedShot, storedShot.version);
      expect(
        (await repositories.shots.findById(context.projectId, context.shot.id))
          ?.visualDescription,
      ).toBe('Updated visual direction');

      const createdDraft = await repositories.workflowDrafts.create(
        draft,
        `pg-draft-${draft.id}`,
      );
      expect(createdDraft.editorGraphJson).toEqual(draft.editorGraphJson);
      const updatedDraft = await repositories.workflowDrafts.update(
        {
          ...createdDraft,
          editorGraphJson: { nodes: [{ id: 18 }] },
          version: 2,
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        1,
        `pg-draft-update-${draft.id}`,
      );
      expect(updatedDraft.version).toBe(2);

      const createdRevision = await repositories.workflowRevisions.create(
        revision,
        `pg-revision-${revision.id}`,
      );
      expect(createdRevision.revisionNumber).toBe(1);
      const validatedRevision =
        await repositories.workflowRevisions.updateValidation(
          context.tenantId,
          context.projectId,
          context.shot.id,
          createdRevision.id,
          {
            validationStatus: 'validated',
            validationErrorsJson: [],
            validatedAt: timestamp,
            executorFingerprint: 'fingerprint-v1',
          },
        );
      expect(validatedRevision.validationStatus).toBe('validated');

      const attempt = createGenerationAttempt({
        id: id(),
        tenantId: context.tenantId,
        projectId: context.projectId,
        shotId: context.shot.id,
        idempotencyKey: 'pg-managed-attempt',
        seed: 17,
        steps: 20,
        requestedWidth: 960,
        requestedHeight: 544,
        requestedDurationSeconds: 5,
        workflowRevisionId: createdRevision.id,
        workflowHash: createdRevision.executionHash,
        correlationId: 'pg-managed-correlation',
        estimatedCostMicrousd: parseUsdToMicrousd('0.10'),
        now: timestamp,
      });
      await repositories.attempts.create(attempt);
      managedAttempt = attempt;
      expect(
        (await repositories.attempts.findById(context.tenantId, attempt.id))
          ?.workflowRevisionId,
      ).toBe(createdRevision.id);
      await repositories.events.append(event);
      const createdRecommendation = recommendationFor(context, event.id);
      recommendation = createdRecommendation;
      await repositories.recommendations.create(createdRecommendation);
      expect(
        await repositories.recommendations.findById(
          context.tenantId,
          context.projectId,
          recommendation.id,
        ),
      ).toMatchObject({ recommendationCode: 'EXECUTOR_UNAVAILABLE' });
    });

    if (!managedAttempt || !recommendation) {
      throw new Error('Expected managed attempt and recommendation.');
    }
    await expect(
      store.withTransaction((repositories) =>
        repositories.attempts.update(
          { ...managedAttempt, seed: 18, version: 2 },
          1,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      store.withTransaction((repositories) =>
        repositories.recommendations.create({
          ...recommendation,
          id: id(),
        }),
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        'UPDATE workflow_revisions SET api_graph_json = $1::jsonb WHERE id = $2',
        [JSON.stringify({ changed: true }), revision.id],
      ),
    ).rejects.toThrow();
  });

  it('allocates unique monotonic revision numbers under concurrent transactions and enforces scope', async () => {
    const context = await seedProject();
    const revisions = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        store.withTransaction((repositories) =>
          repositories.workflowRevisions.create(
            revisionFor(context, { id: id(), authorId: `user-${index}` }),
            `pg-concurrent-revision-${context.projectId}-${index}`,
          ),
        ),
      ),
    );
    expect(
      revisions
        .map((revision) => revision.revisionNumber)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4]);

    const wrongTenant = id();
    await store.withTransaction(async (repositories) => {
      expect(
        await repositories.workflowRevisions.findById(
          wrongTenant,
          context.projectId,
          context.shot.id,
          revisions[0]?.id as Uuid,
        ),
      ).toBeNull();
    });
    await expect(
      store.withTransaction((repositories) =>
        repositories.workflowDrafts.create(
          draftFor(context, { tenantId: wrongTenant }),
          `pg-wrong-draft-${context.projectId}`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_VIOLATION' });
  });
});
