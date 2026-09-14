import { describe, expect, it } from 'vitest';
import {
  compileAndPersistWorkflow,
  compileWorkflow,
  FIXTURE_MANIFEST,
  FIXTURE_WORKFLOW,
  loadFixtureFiles,
  type WorkflowCompileError,
  type WorkflowNode,
  type WorkflowManifest,
} from './index.js';

function cloneManifest(): WorkflowManifest {
  return structuredClone(FIXTURE_MANIFEST);
}

function cloneWorkflow(): Record<string, WorkflowNode> {
  return structuredClone(FIXTURE_WORKFLOW) as Record<string, WorkflowNode>;
}

function expectCompileError(
  action: () => unknown,
  code: WorkflowCompileError['code'],
): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe('fixture workflow compiler', () => {
  it('patches semantic inputs and produces a stable canonical hash', () => {
    const input = {
      prompt: 'A silver device crossing a moving blue set.',
      width: 960,
      height: 544,
      durationSeconds: 5,
      seed: 1234,
      steps: 12,
    };
    const first = compileWorkflow(input);
    const second = compileWorkflow(input);

    expect(first.workflowHash).toBe(second.workflowHash);
    expect(first.workflow['131']?.inputs).toMatchObject({
      prompt: input.prompt,
      width: 960,
      height: 544,
      length: 120,
    });
    expect(first.workflow['129']?.inputs.noise_seed).toBe(1234);
    expect(first.workflow['124']?.inputs.steps).toBe(12);
    expect(first.durationFrames).toBe(120);
    expect(first.durationSeconds).toBe(5);
  });

  it('reuses an immutable persisted version for the same hash', async () => {
    const versions = new Map<
      string,
      { readonly id: string; readonly workflowHash: string }
    >();
    let creates = 0;
    const persistence = {
      findByHash: async (workflowHash: string) => {
        const version = versions.get(workflowHash);
        return version
          ? {
              ...version,
              version: FIXTURE_MANIFEST.version,
              workflowJson: {},
              createdAt: '2026-01-01T00:00:00.000Z',
            }
          : null;
      },
      create: async (version: {
        readonly id: string;
        readonly version: string;
        readonly workflowHash: string;
        readonly workflowJson: Readonly<Record<string, unknown>>;
        readonly createdAt: string;
      }) => {
        creates += 1;
        versions.set(version.workflowHash, version);
      },
    };

    const first = await compileAndPersistWorkflow(
      { prompt: 'same', seed: 1, steps: 8 },
      persistence,
      { id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' },
    );
    const second = await compileAndPersistWorkflow(
      { prompt: 'same', seed: 1, steps: 8 },
      persistence,
      { id: 'version-2', createdAt: '2026-01-01T00:00:01.000Z' },
    );

    expect(second.workflowHash).toBe(first.workflowHash);
    expect(second.workflowVersionId).toBe(first.workflowVersionId);
    expect(creates).toBe(1);
  });

  it('fails closed for missing and mismatched required nodes', () => {
    const missingNode = cloneWorkflow();
    delete (missingNode as Record<string, unknown>)['131'];
    expectCompileError(
      () => compileWorkflow({ prompt: 'x', seed: 1, steps: 8 }, missingNode),
      'MISSING_NODE',
    );

    const wrongClass = cloneWorkflow();
    const node = wrongClass['131'];
    if (!node) throw new Error('fixture node missing');
    wrongClass['131'] = { ...node, class_type: 'WrongNode' };
    expectCompileError(
      () => compileWorkflow({ prompt: 'x', seed: 1, steps: 8 }, wrongClass),
      'MISMATCHED_NODE_CLASS',
    );
  });

  it('fails closed for every required binding shape', () => {
    const missingBinding = {
      ...cloneManifest(),
      bindings: cloneManifest().bindings.filter(
        (binding) => binding.name !== 'prompt',
      ),
    };
    expectCompileError(
      () =>
        compileWorkflow(
          { prompt: 'x', seed: 1, steps: 8 },
          FIXTURE_WORKFLOW,
          missingBinding,
        ),
      'MISSING_BINDING',
    );

    const wrongClass = {
      ...cloneManifest(),
      bindings: cloneManifest().bindings.map((binding) =>
        binding.name === 'prompt'
          ? { ...binding, classType: 'WrongNode' }
          : binding,
      ),
    };
    expectCompileError(
      () =>
        compileWorkflow(
          { prompt: 'x', seed: 1, steps: 8 },
          FIXTURE_WORKFLOW,
          wrongClass,
        ),
      'MISMATCHED_NODE_CLASS',
    );

    const missingPath = {
      ...cloneManifest(),
      bindings: cloneManifest().bindings.map((binding) =>
        binding.name === 'prompt'
          ? { ...binding, path: ['inputs', 'missing'] }
          : binding,
      ),
    };
    expectCompileError(
      () =>
        compileWorkflow(
          { prompt: 'x', seed: 1, steps: 8 },
          FIXTURE_WORKFLOW,
          missingPath,
        ),
      'MISSING_BINDING_PATH',
    );

    const unknownBinding = {
      ...cloneManifest(),
      bindings: [
        ...cloneManifest().bindings,
        {
          name: 'unknown' as never,
          nodeId: '131',
          classType: 'MiniMaxH3ImageToVideo',
          path: ['inputs', 'prompt'],
        },
      ],
    };
    expectCompileError(
      () =>
        compileWorkflow(
          { prompt: 'x', seed: 1, steps: 8 },
          FIXTURE_WORKFLOW,
          unknownBinding,
        ),
      'INVALID_WORKFLOW',
    );
  });

  it('enforces preview dimensions, duration, and parameter limits', () => {
    expectCompileError(
      () => compileWorkflow({ prompt: 'x', width: 928, seed: 1, steps: 8 }),
      'INVALID_PREVIEW_DIMENSIONS',
    );
    expectCompileError(
      () => compileWorkflow({ prompt: 'x', height: 512, seed: 1, steps: 8 }),
      'INVALID_PREVIEW_DIMENSIONS',
    );
    expectCompileError(
      () =>
        compileWorkflow({
          prompt: 'x',
          durationSeconds: 0.5,
          seed: 1,
          steps: 8,
        }),
      'INVALID_DURATION_GRID',
    );
    expectCompileError(
      () =>
        compileWorkflow({
          prompt: 'x',
          durationSeconds: 11,
          seed: 1,
          steps: 8,
        }),
      'INVALID_DURATION_GRID',
    );
    expectCompileError(
      () => compileWorkflow({ prompt: 'x', seed: 1, steps: 0 }),
      'INVALID_PARAMETER',
    );
  });

  it('loads the checked-in fixture files', async () => {
    const fixture = await loadFixtureFiles();
    expect(fixture.manifest.family).toBe('h3-t2v-fixture');
    expect(fixture.manifest.requiredNodes).toContainEqual({
      nodeId: '92',
      classType: 'SaveVideo',
    });
    expect(fixture.workflow['131']?.class_type).toBe('MiniMaxH3ImageToVideo');
  });
});
