import type {
  StreamFn,
  TelemetryContext,
  TelemetrySpan,
} from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import type { AgentRunFailureCode, AgentRunStatus } from '@h3/db';
import type {
  AgentTelemetry,
  TelemetryAttributes,
  TelemetrySpanHandle,
} from '@h3/telemetry';

/**
 * Bookkeeping every Pi run in this service needs, whatever it reasons about:
 * reading a transcript, totalling its usage, adapting telemetry, and naming
 * how a run ended. Extracted when the session digest became the second caller
 * (`docs/75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` step 4), on the same
 * grounds as `redact.ts` -- one implementation, two callers, so a fix to
 * either reaches both.
 */

export function assistantMessages(
  messages: readonly unknown[],
): AssistantMessage[] {
  return messages.filter(
    (message): message is AssistantMessage =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'assistant',
  );
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function usageTotals(messages: readonly AssistantMessage[]) {
  return messages.reduce(
    (totals, message) => ({
      inputTokens: totals.inputTokens + message.usage.input,
      outputTokens: totals.outputTokens + message.usage.output,
      totalTokens: totals.totalTokens + message.usage.totalTokens,
      cacheReadTokens: totals.cacheReadTokens + message.usage.cacheRead,
      cacheWriteTokens: totals.cacheWriteTokens + message.usage.cacheWrite,
      providerCostMicrousd:
        totals.providerCostMicrousd +
        Math.round(message.usage.cost.total * 1_000_000),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerCostMicrousd: 0,
    },
  );
}

export type PiUsageTotals = ReturnType<typeof usageTotals>;

export function telemetryAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): TelemetryAttributes {
  if (!attributes) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      result[key] = value;
    }
  }
  return result;
}

export function piTelemetryContext(
  telemetry: AgentTelemetry,
  parent: TelemetrySpanHandle,
): TelemetryContext {
  type AdaptedPiSpan = TelemetrySpan & { close: () => void };
  const createSpan = (
    options: { name: string; attributes?: Readonly<Record<string, unknown>> },
    parentSpan: TelemetrySpanHandle,
  ): AdaptedPiSpan => {
    const span = telemetry.startSpan(
      options.name,
      telemetryAttributes(options.attributes),
      parentSpan,
    );
    return {
      addEvent: (name, attributes) =>
        span.addEvent(name, telemetryAttributes(attributes)),
      setAttributes: (attributes) =>
        span.setAttributes(telemetryAttributes(attributes)),
      setStatus: (status) =>
        span.setStatus(status.status === 'ok' ? 'ok' : 'error'),
      close: () => span.end(),
      startSpan: async (childOptions, callback) => {
        const child = createSpan(childOptions, span);
        try {
          return await callback(child);
        } finally {
          child.close();
        }
      },
    };
  };
  return {
    startSpan: async (options, callback) => {
      const span = createSpan(options, parent);
      try {
        return await callback(span);
      } finally {
        span.close();
      }
    },
  };
}

export function failureCodeFor(error: unknown): AgentRunFailureCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'PROVIDER_ERROR' ||
      error.code === 'ABORTED' ||
      error.code === 'TIMEOUT' ||
      error.code === 'INVALID_STRUCTURED_OUTPUT' ||
      error.code === 'POLICY_DENIED' ||
      error.code === 'APPLICATION_ERROR')
  ) {
    return error.code;
  }
  return 'APPLICATION_ERROR';
}

export function asAgentRunStatus(
  success: boolean,
  error: unknown,
): AgentRunStatus {
  if (success) return 'succeeded';
  return failureCodeFor(error) === 'ABORTED' ? 'aborted' : 'failed';
}

export interface HostedModelOptions {
  readonly provider: string;
  readonly model: string;
  /** Test-only. Always wins over real provider construction, whatever `provider` says. */
  readonly streamFnOverride?: StreamFn | undefined;
}

/**
 * Resolves the model and stream function for a non-faux run. One
 * implementation for the per-incident operator and the session digest, so
 * adding a provider is one edit rather than two that can drift.
 */
export function resolveHostedModel(options: HostedModelOptions): {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
} {
  if (options.streamFnOverride) {
    const shape = fauxProvider({
      provider: options.provider,
      models: [{ id: options.model, name: options.model }],
    }).getModel() as Model<Api>;
    return { model: shape, streamFn: options.streamFnOverride };
  }
  if (options.provider === 'deepseek') {
    const models = createModels();
    models.setProvider(deepseekProvider());
    const model = models.getModel('deepseek', options.model);
    if (!model) {
      throw Object.assign(
        new Error(`Unknown DeepSeek model "${options.model}".`),
        { code: 'PROVIDER_ERROR' },
      );
    }
    return {
      model,
      streamFn: (streamModel, context, streamOptions) =>
        models.streamSimple(streamModel, context, streamOptions),
    };
  }
  throw Object.assign(
    new Error(
      `The operational provider "${options.provider}" is not supported.`,
    ),
    { code: 'PROVIDER_ERROR' },
  );
}
