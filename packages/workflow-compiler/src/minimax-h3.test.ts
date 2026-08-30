import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  hashWorkflowExecutionEnvelope,
  loadMinimaxH3Fixtures,
  MINIMAX_H3_COMPATIBILITY_MANIFEST,
  MINIMAX_H3_DEFAULT_STEPS,
  MINIMAX_H3_EXECUTOR_OBJECT_INFO,
  MINIMAX_H3_REQUIRED_API_NODE_CLASSES,
  minimaxH3DurationToFrames,
  normalizeAttemptOutputPrefix,
  validateMinimaxH3T2vaPreview,
  type WorkflowValidationCode,
} from './index.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function codes(
  result: ReturnType<typeof validateMinimaxH3T2vaPreview>,
): readonly WorkflowValidationCode[] {
  return result.errors.map((error) => error.code);
}

describe('pinned MiniMax H3 T2VA preview profile', () => {
  it('passes the pinned editor/API golden fixtures and exposes the compatibility contract', async () => {
    const fixtures = await loadMinimaxH3Fixtures();
    const result = validateMinimaxH3T2vaPreview({
      editorGraph: fixtures.editorGraph,
      apiGraph: fixtures.apiGraph,
      objectInfo: MINIMAX_H3_EXECUTOR_OBJECT_INFO,
    });

    expect(fixtures.manifest).toEqual(MINIMAX_H3_COMPATIBILITY_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.effectiveParameters).toMatchObject({
      width: 960,
      height: 544,
      fps: 24,
      frames: 124,
      requestedDurationSeconds: 5,
      steps: MINIMAX_H3_DEFAULT_STEPS,
      turbo: false,
      nativeAudio: true,
      audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
    });
    expect(result.executorFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const apiClasses = Object.values(
      fixtures.apiGraph as Record<string, { class_type: string }>,
    ).map((node) => node.class_type);
    for (const classType of MINIMAX_H3_REQUIRED_API_NODE_CLASSES) {
      expect(apiClasses).toContain(classType);
    }
    expect(minimaxH3DurationToFrames(5)).toBe(124);
  });

  it('hashes canonical execution envelopes independently of object-key order', () => {
    const first = {
      profileId: 'minimax-h3-t2va-preview',
      profileVersion: '1',
      apiGraph: { b: { inputs: { seed: 42 } }, a: { class_type: 'Fixture' } },
      parameters: { steps: 20, frames: 124 },
    };
    const reordered = {
      parameters: { frames: 124, steps: 20 },
      apiGraph: { a: { class_type: 'Fixture' }, b: { inputs: { seed: 42 } } },
      profileVersion: '1',
      profileId: 'minimax-h3-t2va-preview',
    };
    expect(hashWorkflowExecutionEnvelope(first)).toBe(
      hashWorkflowExecutionEnvelope(reordered),
    );
    expect(
      hashWorkflowExecutionEnvelope({
        ...first,
        parameters: { steps: 20, frames: 141 },
      }),
    ).not.toBe(hashWorkflowExecutionEnvelope(first));
    expect(() => canonicalizeJson(Number.NaN)).toThrow();
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalizeJson(sparse)).toThrow();
  });

  it('rejects export mismatches, unsafe nodes, and semantic parameter violations', async () => {
    const fixtures = await loadMinimaxH3Fixtures();
    const mismatchedApi = clone(fixtures.apiGraph);
    const apiNode = mismatchedApi['131'] as Record<string, unknown>;
    const apiInputs = apiNode.inputs as Record<string, unknown>;
    apiInputs.width = 950;
    const mismatch = validateMinimaxH3T2vaPreview({
      editorGraph: fixtures.editorGraph,
      apiGraph: mismatchedApi,
    });
    expect(codes(mismatch)).toContain('GRAPH_EXPORT_MISMATCH');
    expect(codes(mismatch)).toContain('DIMENSION_INVALID');

    const unsafeApi = clone(fixtures.apiGraph) as Record<string, unknown>;
    unsafeApi['999'] = {
      class_type: 'ExecuteShellCommand',
      inputs: {},
    };
    const unsafe = validateMinimaxH3T2vaPreview({
      editorGraph: fixtures.editorGraph,
      apiGraph: unsafeApi,
    });
    expect(codes(unsafe)).toContain('UNSAFE_NODE');

    const invalidApi = clone(fixtures.apiGraph);
    const h3Node = invalidApi['131'] as Record<string, unknown>;
    const h3Inputs = h3Node.inputs as Record<string, unknown>;
    h3Inputs.length = 120;
    const scheduler = invalidApi['124'] as Record<string, unknown>;
    const schedulerInputs = scheduler.inputs as Record<string, unknown>;
    schedulerInputs.steps = 8;
    const video = invalidApi['130'] as Record<string, unknown>;
    const videoInputs = video.inputs as Record<string, unknown>;
    videoInputs.fps = 30;
    const semantic = validateMinimaxH3T2vaPreview({
      editorGraph: fixtures.editorGraph,
      apiGraph: invalidApi,
    });
    expect(codes(semantic)).toEqual(
      expect.arrayContaining(['DURATION_GRID_INVALID', 'PARAMETER_MISMATCH']),
    );
  });

  it('requires native audio wiring and rejects capability drift', async () => {
    const fixtures = await loadMinimaxH3Fixtures();
    const noAudio = clone(fixtures.apiGraph);
    const createVideo = noAudio['130'] as Record<string, unknown>;
    const inputs = createVideo.inputs as Record<string, unknown>;
    delete inputs.audio;
    const audioResult = validateMinimaxH3T2vaPreview({
      editorGraph: fixtures.editorGraph,
      apiGraph: noAudio,
    });
    expect(codes(audioResult)).toContain('OUTPUT_CONTRACT_INVALID');

    const driftedInfo = clone(MINIMAX_H3_EXECUTOR_OBJECT_INFO);
    delete (driftedInfo as Record<string, unknown>).VAEDecodeAudio;
    const driftResult = validateMinimaxH3T2vaPreview({
      editorGraph: fixtures.editorGraph,
      apiGraph: fixtures.apiGraph,
      objectInfo: driftedInfo,
    });
    expect(codes(driftResult)).toContain('NODE_CLASS_MISSING');
    expect(codes(driftResult)).toContain('CAPABILITY_DRIFT');
    expect(driftResult.valid).toBe(false);
  });

  it('keeps server output names attempt-scoped and safe', () => {
    expect(normalizeAttemptOutputPrefix('attempt_01')).toBe(
      'videoops/attempt-attempt_01',
    );
    expect(() => normalizeAttemptOutputPrefix('../escape')).toThrow();
  });
});
