import { describe, expect, it } from 'vitest';
import {
  ComfySubmissionUncertainError,
  DeterministicFakeComfyService,
  FakeComfyClient,
  type ComfyScenario,
} from './index.js';

const waitForTimers = async (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

describe('Comfy client contract', () => {
  it.each([
    'success',
    'duplicate-events',
    'disconnect-reconcile',
    'execution-failure',
    'timeout',
    'uncertain-submission',
  ] as ComfyScenario[])('supports the %s fake scenario', async (scenario) => {
    const service = new DeterministicFakeComfyService();
    const client = new FakeComfyClient(service);
    const correlationId = `contract-${scenario}`;
    let promptId: string | undefined;
    if (scenario === 'uncertain-submission') {
      await expect(
        client.submitPrompt({
          workflow: { '1': { class_type: 'CLIPTextEncode' } },
          extraData: { correlation_id: correlationId, scenario, seed: 7 },
          scenario,
          seed: 7,
        }),
      ).rejects.toBeInstanceOf(ComfySubmissionUncertainError);
      const recovered = await client.findHistoryByCorrelation(correlationId);
      promptId = recovered?.promptId;
      expect(promptId).toBeDefined();
    } else {
      promptId = (
        await client.submitPrompt({
          workflow: { '1': { class_type: 'CLIPTextEncode' } },
          extraData: { correlation_id: correlationId, scenario, seed: 7 },
          scenario,
          seed: 7,
        })
      ).promptId;
    }
    await waitForTimers();
    const history = await client.getHistory(promptId as string);
    expect(history?.extraData.correlation_id).toBe(correlationId);
    if (scenario === 'timeout') {
      expect(history?.status).toBe('running');
      await client.cancelPrompt(promptId);
      expect((await client.getHistory(promptId as string))?.status).toBe(
        'interrupted',
      );
    } else if (scenario === 'execution-failure') {
      expect(history?.status).toBe('error');
    } else {
      expect(history?.status).toBe('success');
      expect(history?.outputs).toHaveLength(1);
    }
    expect(service.submissionCount(correlationId)).toBe(1);
  });

  it('replays terminal events and validates workflow classes', async () => {
    const service = new DeterministicFakeComfyService();
    const client = new FakeComfyClient(service);
    const valid = await client.validateWorkflow({
      '1': { class_type: 'CLIPTextEncode' },
      '2': { class_type: 'SaveVideo' },
    });
    const invalid = await client.validateWorkflow({
      '1': { class_type: 'MissingNode' },
    });
    expect(valid.valid).toBe(true);
    expect(invalid).toEqual({ valid: false, missingClasses: ['MissingNode'] });

    const { promptId } = await client.submitPrompt({
      workflow: {},
      extraData: { correlation_id: 'replay' },
      seed: 1,
    });
    await waitForTimers();
    const messages: string[] = [];
    for await (const message of client.events({ promptId })) {
      messages.push(message.type);
    }
    expect(messages).toContain('execution_success');
  });
});
