import { describe, expect, it } from 'vitest';
import { parseSseFrames } from './api.js';
import {
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_SOURCE,
  BridgeProtocolError,
  validateParentBridgeEvent,
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
      type: 'bridge.ready',
      requestId: 'ready-1',
      nonce: 'nonce-1',
      frontendVersion: 'pinned',
    };
    const seen = new Set<string>();
    expect(() =>
      validateParentBridgeEvent(
        { origin: 'https://evil.test', source: frame, data: message },
        'https://studio.test',
        frame,
        'nonce-1',
        seen,
      ),
    ).toThrowError(BridgeProtocolError);
    expect(() =>
      validateParentBridgeEvent(
        { origin: 'https://studio.test', source: {}, data: message },
        'https://studio.test',
        frame,
        'nonce-1',
        seen,
      ),
    ).toThrowError(BridgeProtocolError);
  });
});
