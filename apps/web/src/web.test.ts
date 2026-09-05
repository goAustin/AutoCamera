import { unresolvableNodeClasses } from './App.js';
import { describe, expect, it } from 'vitest';
import * as api from './api.js';
import { parseSseFrames } from './api.js';
import {
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_SOURCE,
  BridgeProtocolError,
  createPanelBridgeMessage,
  validateComfyBridgeEvent,
} from './bridge.js';
import {
  buildFakeWorkflowGraphs,
  DEFAULT_FAKE_WORKFLOW_SETTINGS,
  durationToFrames,
} from './workflow-fixture.js';

describe('Project Studio browser contracts', () => {
  it('builds a deterministic H3 graph pair from bounded fake-mode settings', () => {
    const graphs = buildFakeWorkflowGraphs({
      ...DEFAULT_FAKE_WORKFLOW_SETTINGS,
      prompt: 'A focused studio test.',
      seed: 123,
      durationSeconds: 5,
    });
    const h3 = graphs.apiGraph['131'] as { inputs: Record<string, unknown> };
    const noise = graphs.apiGraph['129'] as { inputs: Record<string, unknown> };
    expect(h3.inputs).toMatchObject({
      prompt: 'A focused studio test.',
      width: 960,
      height: 544,
      length: 124,
    });
    expect(noise.inputs.noise_seed).toBe(123);
    expect(durationToFrames(5)).toBe(124);
  });

  it('parses replayable SSE frames and ignores heartbeat comments', () => {
    expect(
      parseSseFrames(
        ': heartbeat\n\nid: 7\nevent: attempt.running\ndata: {"status":"running"}\n\n',
      ),
    ).toEqual([
      { id: 7, type: 'attempt.running', data: { status: 'running' } },
    ]);
  });

  it('fails closed for an unexpected bridge origin or source window', () => {
    const frame = {};
    const message = {
      source: BRIDGE_SOURCE,
      version: BRIDGE_SCHEMA_VERSION,
      type: 'comfy.context',
      requestId: 'context-1',
      nonce: 'nonce-1',
      frontendVersion: 'pinned',
    } as const;
    const seen = new Set<string>();
    expect(() =>
      validateComfyBridgeEvent(
        { origin: 'https://evil.test', source: frame, data: message },
        'https://studio.test',
        frame,
        'nonce-1',
        seen,
      ),
    ).toThrowError(BridgeProtocolError);
    expect(() =>
      validateComfyBridgeEvent(
        { origin: 'https://studio.test', source: {}, data: message },
        'https://studio.test',
        frame,
        'nonce-1',
        seen,
      ),
    ).toThrowError(BridgeProtocolError);
    expect(createPanelBridgeMessage('panel.ready', 'nonce-1')).toMatchObject({
      type: 'panel.ready',
      nonce: 'nonce-1',
    });
  });
});

describe('managed run graph fidelity guard', () => {
  const resolved = {
    '1': { class_type: 'MiniMaxH3ImageToVideo' },
    '2': { class_type: 'SaveVideo' },
  };

  it('accepts an export made only of resolvable helper and profile nodes', () => {
    expect(
      unresolvableNodeClasses(
        {
          a: { class_type: 'ResolutionSelector' },
          b: { class_type: 'ComfyMathExpression' },
          c: { class_type: 'PrimitiveInt' },
          d: { class_type: 'MiniMaxH3ImageToVideo' },
          e: { class_type: 'SaveVideo' },
        },
        resolved,
      ),
    ).toEqual([]);
  });

  it('reports nodes the resolver cannot express', () => {
    // Previously these were silently dropped: the rebuilt graph was submitted
    // and hashed, so the audit record described a workflow the user never built.
    expect(
      unresolvableNodeClasses(
        {
          a: { class_type: 'MiniMaxH3ImageToVideo' },
          b: { class_type: 'LoraLoader' },
          c: { class_type: 'UpscaleModelLoader' },
        },
        resolved,
      ),
    ).toEqual(['LoraLoader', 'UpscaleModelLoader']);
  });

  it('deduplicates and ignores malformed nodes', () => {
    expect(
      unresolvableNodeClasses(
        {
          a: { class_type: 'LoraLoader' },
          b: { class_type: 'LoraLoader' },
          c: null,
          d: { missing: true },
        },
        resolved,
      ),
    ).toEqual(['LoraLoader']);
  });

  it('treats a non-object export as empty rather than throwing', () => {
    expect(unresolvableNodeClasses(undefined, resolved)).toEqual([]);
  });
});

describe('apps/web/src/api.ts export surface', () => {
  // `RunView` (plus the recovery-path components it renders -- `AttemptCard`,
  // `ArtifactPlayer`, `RecommendationPanel`) and `ManagedPanelPage`'s own
  // bridge logic call exactly these `api.ts` functions. A later deletion in
  // `api.ts` (e.g. mistaking one of these for more brief-first surface)
  // would silently break the run view with no compile error, since
  // `apps/web` is only checked with `tsc --noEmit` and JavaScript does not
  // fail a missing named export until the call site actually runs. This
  // test is the guard the checkpoint requires for that.
  const requiredExports = [
    'acceptAttempt',
    'applyRecommendation',
    'createRun',
    'dismissRecommendation',
    'fetchArtifact',
    'fetchProjectEventStream',
    'getAttemptDetail',
    'getRun',
    'listRecommendations',
    'listRuns',
    'rejectAttempt',
    'retryAttempt',
    'pinRun',
    'reviewRun',
    'unpinRun',
    'validateWorkflowRevision',
  ] as const;

  it.each(requiredExports)('still exports %s as a function', (name) => {
    expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
  });

  it('still exports the project-management functions step 5 requires, even though RunView has no project-management UI of its own', () => {
    // `POST /v1/projects` (with `budgetUsd`) and `GET .../cost` are the cost
    // breaker (design doc step 5); `getProject` and `listProjects` back it.
    // RunView never calls these itself -- it has no project-creation or
    // project-list screen -- but they must stay exported.
    for (const name of [
      'createProject',
      'getProject',
      'listProjects',
      'getCost',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
