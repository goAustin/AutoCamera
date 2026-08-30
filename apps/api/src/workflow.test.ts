import { describe, expect, it } from 'vitest';
import {
  createShot,
  createStoryboardProposal,
  createUuidV7,
  createVideoProject,
  parseUsdToMicrousd,
  type IsoUtcTimestamp,
  type Uuid,
} from '@h3/domain';
import { createInMemoryStore } from '@h3/db';
import {
  hashWorkflowExecutionEnvelope,
  loadMinimaxH3Fixtures,
  MINIMAX_H3_EXECUTOR_OBJECT_INFO,
} from '@h3/workflow-compiler';
import {
  WorkflowApplicationService,
  type CreateWorkflowDraftCommand,
  type CreateWorkflowRevisionCommand,
} from './workflow.js';

const timestamp = '2026-01-01T00:00:00.000Z' as IsoUtcTimestamp;

function id(seed: number): Uuid {
  return createUuidV7(
    1_700_000_000_000 + seed,
    new Uint8Array(10).fill((seed % 250) + 1),
  );
}

interface ProjectContext {
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
}

async function seedProject(
  store: ReturnType<typeof createInMemoryStore>,
  seed: number,
): Promise<ProjectContext> {
  const tenantId = id(seed);
  const project = createVideoProject({
    id: id(seed + 1),
    tenantId,
    title: `Workflow project ${seed}`,
    brief: 'A project used for workflow application-service tests.',
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
    id: id(seed + 3),
    projectId: project.id,
    storyboardProposalId: proposal.id,
    definition,
    now: timestamp,
  });
  await store.withTransaction(async (repositories) => {
    await repositories.tenants.ensure(
      tenantId,
      'Workflow test tenant',
      timestamp,
    );
    await repositories.projects.create(project);
    await repositories.storyboards.create(proposal);
    await repositories.shots.createMany([shot]);
  });
  return { tenantId, projectId: project.id, shotId: shot.id };
}

async function revisionCommand(
  idempotencyKey: string,
): Promise<CreateWorkflowRevisionCommand> {
  const fixtures = await loadMinimaxH3Fixtures();
  return {
    idempotencyKey,
    editorGraphJson: fixtures.editorGraph,
    apiGraphJson: fixtures.apiGraph,
    authorType: 'development_user',
    authorId: 'workflow-test-user',
    executorObjectInfo: MINIMAX_H3_EXECUTOR_OBJECT_INFO,
  };
}

async function draftCommand(
  idempotencyKey: string,
): Promise<CreateWorkflowDraftCommand> {
  const fixtures = await loadMinimaxH3Fixtures();
  return {
    idempotencyKey,
    editorGraphJson: fixtures.editorGraph,
    lastApiGraphJson: fixtures.apiGraph,
    authorType: 'development_user',
    authorId: 'workflow-test-user',
  };
}

describe('workflow application services', () => {
  it('creates mutable scoped drafts with idempotent optimistic updates', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 1);
    const service = new WorkflowApplicationService({
      store,
      tenantId: context.tenantId,
    });

    const created = await service.createWorkflowDraft(
      context.projectId,
      context.shotId,
      await draftCommand('draft-create'),
    );
    expect(created.version).toBe(1);
    expect(
      await service.createWorkflowDraft(
        context.projectId,
        context.shotId,
        await draftCommand('draft-create'),
      ),
    ).toEqual(created);

    const updateCommand = {
      ...(await draftCommand('draft-update')),
      expectedVersion: 1,
      lastApiGraphJson: null,
    };
    const updated = await service.updateWorkflowDraft(
      context.projectId,
      context.shotId,
      updateCommand,
    );
    expect(updated.version).toBe(2);
    expect(updated.lastApiGraphJson).toBeUndefined();
    expect(
      await service.updateWorkflowDraft(
        context.projectId,
        context.shotId,
        updateCommand,
      ),
    ).toEqual(updated);
    await expect(
      service.updateWorkflowDraft(context.projectId, context.shotId, {
        ...(await draftCommand('draft-stale')),
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_CONFLICT' });
  });

  it('creates immutable revisions with lineage and a hash that excludes editor layout', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 20);
    const service = new WorkflowApplicationService({
      store,
      tenantId: context.tenantId,
    });
    const firstCommand = await revisionCommand('revision-create-1');
    const first = await service.createWorkflowRevision(
      context.projectId,
      context.shotId,
      firstCommand,
    );
    expect(first.revision.validationStatus).toBe('validated');
    expect(first.revision.revisionNumber).toBe(1);
    expect(first.revision.executionHash).toBe(
      hashWorkflowExecutionEnvelope({
        profileId: first.revision.profileId,
        profileVersion: first.revision.profileVersion,
        apiGraph: first.revision.apiGraphJson,
        parameters: first.revision.executionParametersJson,
      }),
    );
    expect(
      await service.createWorkflowRevision(
        context.projectId,
        context.shotId,
        firstCommand,
      ),
    ).toEqual(first);

    const secondCommand = await revisionCommand('revision-create-2');
    const movedEditorGraph = structuredClone(secondCommand.editorGraphJson);
    const movedNode = (
      movedEditorGraph.nodes as Array<Record<string, unknown>>
    )[0];
    if (!movedNode) throw new Error('Expected an editor graph node.');
    movedNode.pos = [999, 999];
    const second = await service.createWorkflowRevision(
      context.projectId,
      context.shotId,
      {
        ...secondCommand,
        editorGraphJson: movedEditorGraph,
        parentRevisionId: first.revision.id,
      },
    );
    expect(second.revision.revisionNumber).toBe(2);
    expect(second.revision.parentRevisionId).toBe(first.revision.id);
    expect(second.revision.executionHash).toBe(first.revision.executionHash);
    expect(
      (
        await service.listWorkflowRevisions(context.projectId, context.shotId)
      ).map((revision) => revision.revisionNumber),
    ).toEqual([1, 2]);
  });

  it('persists invalid revisions for inspection and records executor capability drift', async () => {
    const store = createInMemoryStore();
    const context = await seedProject(store, 40);
    const service = new WorkflowApplicationService({
      store,
      tenantId: context.tenantId,
      requireExecutor: true,
    });
    const command = await revisionCommand('revision-invalid');
    const apiGraph = structuredClone(command.apiGraphJson);
    const h3Node = apiGraph['131'] as Record<string, unknown>;
    (h3Node.inputs as Record<string, unknown>).length = 120;
    const created = await service.createWorkflowRevision(
      context.projectId,
      context.shotId,
      { ...command, apiGraphJson: apiGraph },
    );
    expect(created.revision.validationStatus).toBe('invalid');
    expect(created.revision.validationErrorsJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DURATION_GRID_INVALID' }),
      ]),
    );

    const drifted = structuredClone(MINIMAX_H3_EXECUTOR_OBJECT_INFO);
    delete (drifted as Record<string, unknown>).CreateVideo;
    const driftedRevision = await service.createWorkflowRevision(
      context.projectId,
      context.shotId,
      {
        ...(await revisionCommand('revision-drift')),
        executorObjectInfo: drifted,
      },
    );
    expect(driftedRevision.revision.validationStatus).toBe('invalid');
    expect(driftedRevision.revision.validationErrorsJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'NODE_CLASS_MISSING' }),
      ]),
    );
  });

  it('rejects parent and resource scope mismatches without leaking records', async () => {
    const store = createInMemoryStore();
    const firstContext = await seedProject(store, 60);
    const secondContext = await seedProject(store, 80);
    const service = new WorkflowApplicationService({
      store,
      tenantId: firstContext.tenantId,
    });
    const first = await service.createWorkflowRevision(
      firstContext.projectId,
      firstContext.shotId,
      await revisionCommand('scope-revision'),
    );

    const secondService = new WorkflowApplicationService({
      store,
      tenantId: secondContext.tenantId,
    });
    await expect(
      secondService.createWorkflowRevision(
        secondContext.projectId,
        secondContext.shotId,
        {
          ...(await revisionCommand('scope-parent')),
          parentRevisionId: first.revision.id,
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_SCOPE_VIOLATION' });

    await expect(
      secondService.getWorkflowRevision(
        secondContext.projectId,
        secondContext.shotId,
        first.revision.id,
      ),
    ).resolves.toBeNull();

    await expect(
      service.createWorkflowDraft(
        secondContext.projectId,
        firstContext.shotId,
        await draftCommand('wrong-shot'),
      ),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_PROJECT_NOT_FOUND',
    });
  });
});
