import { describe, expect, it } from 'vitest';
import {
  createDomainEvent,
  createGenerationAttempt,
  createShot,
  createStoryboardProposal,
  createUuidV7,
  createVideoProject,
  parseUsdToMicrousd,
  type Shot,
  type Uuid,
} from '@h3/domain';
import {
  canonicalizeJson,
  createInMemoryStore,
  hashWorkflowExecutionEnvelope,
  type OperationalRecommendationRecord,
  type WorkflowDraftRecord,
  type WorkflowRevisionRecord,
} from './index.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function id(seed: number): Uuid {
  return createUuidV7(
    1_700_000_000_000 + seed,
    new Uint8Array(10).fill((seed % 250) + 1),
  );
}

interface SeededProject {
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shot: Shot;
}

async function seedProject(
  store: ReturnType<typeof createInMemoryStore>,
  seed: number,
): Promise<SeededProject> {
  const tenantId = id(seed);
  const project = createVideoProject({
    id: id(seed + 1),
    tenantId,
    title: `Project ${seed}`,
    brief: 'A structured persistence test project.',
    targetDurationSeconds: 3,
    budgetMicrousd: parseUsdToMicrousd('25'),
    now: timestamp,
  });
  const proposal = createStoryboardProposal({
    id: id(seed + 2),
    projectId: project.id,
    revision: 1,
    shots: [1, 2, 3].map((ordinal) => ({
      ordinal: ordinal as 1 | 2 | 3,
      purpose: `Purpose ${ordinal}`,
      prompt: `Prompt ${ordinal}`,
      durationSeconds: 1,
      mode: 't2v' as const,
      qualityTier: 'preview' as const,
      visualDescription: `Visual direction ${ordinal}`,
      cameraDirection: `Camera direction ${ordinal}`,
      audioDirection: `Audio direction ${ordinal}`,
      ...(ordinal === 1 ? { dialogue: 'A bounded line.' } : {}),
      acceptanceCriteria: [`Criterion ${ordinal}`],
      requiredAssetIds: [],
    })),
    now: timestamp,
  });
  const firstDefinition = proposal.shots[0];
  if (!firstDefinition) throw new Error('Expected first shot definition.');
  const shot = createShot({
    id: id(seed + 3),
    projectId: project.id,
    storyboardProposalId: proposal.id,
    definition: firstDefinition,
    now: timestamp,
  });
  await store.withTransaction(async (repositories) => {
    await repositories.tenants.ensure(tenantId, 'Test tenant', timestamp);
    await repositories.projects.create(project);
    await repositories.storyboards.create(proposal);
    await repositories.shots.createMany([shot]);
  });
  return { tenantId, projectId: project.id, shot };
}

function revisionFor(
  context: SeededProject,
  seed: number,
  overrides: Partial<WorkflowRevisionRecord> = {},
): WorkflowRevisionRecord {
  const apiGraphJson = { '1': { class_type: 'Fixture', inputs: { seed } } };
  const executionParametersJson = { seed, steps: 20 };
  const executionHash = hashWorkflowExecutionEnvelope({
    profileId: 'minimax-h3-t2va-preview',
    profileVersion: '1',
    apiGraph: apiGraphJson,
    parameters: executionParametersJson,
  });
  return {
    id: id(seed + 100),
    tenantId: context.tenantId,
    projectId: context.projectId,
    shotId: context.shot.id,
    revisionNumber: 1,
    profileId: 'minimax-h3-t2va-preview',
    profileVersion: '1',
    source: 'comfy_editor',
    authorType: 'development_user',
    authorId: `user-${seed}`,
    editorGraphJson: { nodes: [{ id: seed }] },
    apiGraphJson,
    executionHash,
    executionParametersJson,
    validationStatus: 'pending',
    validationErrorsJson: [],
    createdAt: timestamp,
    ...overrides,
  };
}

function draftFor(
  context: SeededProject,
  seed: number,
  overrides: Partial<WorkflowDraftRecord> = {},
): WorkflowDraftRecord {
  return {
    id: id(seed + 200),
    tenantId: context.tenantId,
    projectId: context.projectId,
    shotId: context.shot.id,
    profileId: 'minimax-h3-t2va-preview',
    profileVersion: '1',
    editorGraphJson: { nodes: [{ id: seed }] },
    lastApiGraphJson: { '1': { class_type: 'Fixture' } },
    authorType: 'development_user',
    authorId: `user-${seed}`,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function recommendationFor(
  context: SeededProject,
  eventId: Uuid,
  seed: number,
  overrides: Partial<OperationalRecommendationRecord> = {},
): OperationalRecommendationRecord {
  return {
    id: id(seed + 300),
    tenantId: context.tenantId,
    projectId: context.projectId,
    shotId: context.shot.id,
    triggerEventId: eventId,
    severity: 'warning',
    recommendationCode: 'EXECUTOR_UNAVAILABLE',
    title: 'Wait for the executor',
    detail: 'The executor should be checked before retrying this attempt.',
    evidenceReferencesJson: [{ type: 'domain_event', resourceId: eventId }],
    proposedActionType: 'wait_for_executor',
    proposedResourceIdsJson: [context.shot.id],
    status: 'pending',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('Phase 5 Checkpoint 1 in-memory persistence contracts', () => {
  it('canonicalizes execution envelopes deterministically and rejects unsafe JSON', () => {
    const first = {
      profileId: 'minimax-h3-t2va-preview',
      profileVersion: '1',
      apiGraph: { b: { inputs: { seed: 17 } }, a: { class_type: 'Fixture' } },
      parameters: { steps: 20, seed: 17 },
    };
    const reordered = {
      profileId: 'minimax-h3-t2va-preview',
      profileVersion: '1',
      apiGraph: { a: { class_type: 'Fixture' }, b: { inputs: { seed: 17 } } },
      parameters: { seed: 17, steps: 20 },
    };
    expect(hashWorkflowExecutionEnvelope(first)).toBe(
      hashWorkflowExecutionEnvelope(reordered),
    );
    expect(
      hashWorkflowExecutionEnvelope({
        ...reordered,
        parameters: { ...reordered.parameters, steps: 21 },
      }),
    ).not.toBe(hashWorkflowExecutionEnvelope(first));
    expect(() => canonicalizeJson(Number.NaN)).toThrow();
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalizeJson(sparse)).toThrow();
  });

  it('round-trips all structured shot fields and protects draft scope/version', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 1);

    await store.withTransaction(async (repositories) => {
      const stored = await repositories.shots.findById(
        context.projectId,
        context.shot.id,
      );
      expect(stored).toMatchObject({
        visualDescription: 'Visual direction 1',
        cameraDirection: 'Camera direction 1',
        audioDirection: 'Audio direction 1',
        dialogue: 'A bounded line.',
        acceptanceCriteria: ['Criterion 1'],
        requiredAssetIds: [],
      });

      const draft = draftFor(context, 1);
      const created = await repositories.workflowDrafts.create(
        draft,
        'draft-create-1',
      );
      const updated = await repositories.workflowDrafts.update(
        {
          ...created,
          editorGraphJson: { nodes: [{ id: 2 }] },
          version: 2,
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        1,
        'draft-update-1',
      );
      expect(updated.version).toBe(2);
      expect(
        await repositories.workflowDrafts.update(updated, 1, 'draft-update-1'),
      ).toEqual(updated);
      await expect(
        repositories.workflowDrafts.update(
          { ...updated, version: 3 },
          1,
          'draft-stale-1',
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_CONFLICT' });
      expect(
        await repositories.workflowDrafts.findByShot(
          context.tenantId,
          context.projectId,
          context.shot.id,
        ),
      ).toEqual(updated);
    });

    const other = await seedProject(store, 20);
    await store.withTransaction(async (repositories) => {
      expect(
        await repositories.workflowDrafts.findByShot(
          other.tenantId,
          context.projectId,
          context.shot.id,
        ),
      ).toBeNull();
      await expect(
        repositories.workflowDrafts.create(
          draftFor(other, 2, {
            projectId: context.projectId,
            shotId: context.shot.id,
          }),
          'draft-wrong-scope',
        ),
      ).rejects.toMatchObject({ code: 'SCOPE_VIOLATION' });
    });
  });

  it('creates immutable, scoped revisions with canonical hashes and monotonic concurrency', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 40);
    const first = await store.withTransaction((repositories) =>
      repositories.workflowRevisions.create(
        revisionFor(context, 40),
        'revision-40',
      ),
    );
    expect(first.revisionNumber).toBe(1);

    const validated = await store.withTransaction((repositories) =>
      repositories.workflowRevisions.updateValidation(
        context.tenantId,
        context.projectId,
        context.shot.id,
        first.id,
        {
          validationStatus: 'validated',
          validationErrorsJson: [],
          validatedAt: timestamp,
          executorFingerprint: 'fingerprint-v1',
        },
      ),
    );
    expect(validated.validationStatus).toBe('validated');
    expect(validated.apiGraphJson).toEqual(first.apiGraphJson);

    const loaded = await store.withTransaction((repositories) =>
      repositories.workflowRevisions.findById(
        context.tenantId,
        context.projectId,
        context.shot.id,
        first.id,
      ),
    );
    if (!loaded) throw new Error('Expected revision.');
    (loaded.apiGraphJson as Record<string, unknown>).changed = true;
    const unchanged = await store.withTransaction((repositories) =>
      repositories.workflowRevisions.findById(
        context.tenantId,
        context.projectId,
        context.shot.id,
        first.id,
      ),
    );
    expect(unchanged?.apiGraphJson).toEqual(first.apiGraphJson);

    const concurrent = await Promise.all(
      [41, 42, 43, 44].map((seed) =>
        store.withTransaction((repositories) =>
          repositories.workflowRevisions.create(
            revisionFor(context, seed),
            `revision-${seed}`,
          ),
        ),
      ),
    );
    expect(
      concurrent
        .map((revision) => revision.revisionNumber)
        .sort((a, b) => a - b),
    ).toEqual([2, 3, 4, 5]);

    const other = await seedProject(store, 60);
    const sameHash = revisionFor(other, 40, {
      id: id(500),
      editorGraphJson: { nodes: [{ id: 'other-project' }] },
    });
    const otherRevision = await store.withTransaction((repositories) =>
      repositories.workflowRevisions.create(sameHash, 'revision-other'),
    );
    expect(otherRevision.executionHash).toBe(first.executionHash);
    expect(otherRevision.projectId).not.toBe(first.projectId);
  });

  it('links managed attempts only to validated revisions and records derived lineage', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 80);
    const pending = await store.withTransaction((repositories) =>
      repositories.workflowRevisions.create(
        revisionFor(context, 80),
        'revision-pending',
      ),
    );
    const hash = pending.executionHash;
    const attemptInput = {
      id: id(600),
      tenantId: context.tenantId,
      projectId: context.projectId,
      shotId: context.shot.id,
      idempotencyKey: 'managed-attempt',
      seed: 80,
      steps: 20,
      requestedWidth: 960,
      requestedHeight: 544,
      requestedDurationSeconds: 5,
      workflowRevisionId: pending.id,
      workflowHash: hash,
      correlationId: 'managed-correlation',
      estimatedCostMicrousd: parseUsdToMicrousd('0.10'),
      now: timestamp,
    } as const;
    await expect(
      store.withTransaction((repositories) =>
        repositories.attempts.create(createGenerationAttempt(attemptInput)),
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_VIOLATION' });

    await store.withTransaction((repositories) =>
      repositories.workflowRevisions.updateValidation(
        context.tenantId,
        context.projectId,
        context.shot.id,
        pending.id,
        {
          validationStatus: 'validated',
          validationErrorsJson: [],
          validatedAt: timestamp,
          executorFingerprint: 'fingerprint-v1',
        },
      ),
    );
    const source = createGenerationAttempt(attemptInput);
    await store.withTransaction((repositories) =>
      repositories.attempts.create(source),
    );
    const derived = createGenerationAttempt({
      ...attemptInput,
      id: id(601),
      idempotencyKey: 'managed-attempt-retry',
      correlationId: 'managed-correlation-retry',
      sourceAttemptId: source.id,
    });
    await store.withTransaction((repositories) =>
      repositories.attempts.create(derived),
    );
    const stored = await store.withTransaction((repositories) =>
      repositories.attempts.findById(context.tenantId, derived.id),
    );
    expect(stored?.workflowRevisionId).toBe(pending.id);
    expect(stored?.sourceAttemptId).toBe(source.id);
    await expect(
      store.withTransaction((repositories) =>
        repositories.attempts.update(
          { ...source, seed: source.seed + 1, version: source.version + 1 },
          source.version,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const terminal = {
      ...source,
      status: 'failed' as const,
      failureCode: 'COMFY_EXECUTION_FAILED' as const,
      failureMessage: 'terminal failure',
      finishedAt: timestamp,
      version: 2,
    };
    await store.withTransaction((repositories) =>
      repositories.attempts.update(terminal, source.version),
    );
    await expect(
      store.withTransaction((repositories) =>
        repositories.attempts.update(
          { ...terminal, failureMessage: 'changed', version: 3 },
          terminal.version,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('persists recommendation evidence once per trigger and applies optimistic status changes', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 100);
    const event = createDomainEvent({
      id: id(700),
      type: 'attempt.failed',
      producer: 'test',
      tenantId: context.tenantId,
      projectId: context.projectId,
      shotId: context.shot.id,
      clock: { now: () => new Date(timestamp) },
      payload: { code: 'COMFY_UNAVAILABLE' },
    });
    await store.withTransaction((repositories) =>
      repositories.events.append(event),
    );

    await store.withTransaction(async (repositories) => {
      const recommendation = recommendationFor(context, event.id, 100);
      await repositories.recommendations.create(recommendation);
      expect(repositories.operationalRecommendations).toBe(
        repositories.recommendations,
      );
      await expect(
        repositories.recommendations.create({
          ...recommendation,
          id: id(701),
        }),
      ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION' });
      const applied = await repositories.recommendations.updateStatus(
        context.tenantId,
        context.projectId,
        recommendation.id,
        'applied',
        1,
        '2026-01-01T00:00:01.000Z',
      );
      expect(applied.status).toBe('applied');
      await expect(
        repositories.recommendations.updateStatus(
          context.tenantId,
          context.projectId,
          recommendation.id,
          'dismissed',
          1,
          '2026-01-01T00:00:02.000Z',
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_CONFLICT' });
      expect(
        await repositories.recommendations.findById(
          id(101),
          context.projectId,
          recommendation.id,
        ),
      ).toBeNull();
    });
  });

  it('requires mutation idempotency keys for workflow drafts and revisions', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 140);
    await store.withTransaction(async (repositories) => {
      await expect(
        repositories.workflowDrafts.create(draftFor(context, 140), '  '),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(
        repositories.workflowRevisions.create(revisionFor(context, 140), '  '),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
  });
});
