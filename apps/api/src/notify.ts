import { isUuidV7, type DomainEvent } from '@h3/domain';
import type { OutboxConsumer, OutboxMessage, Repositories } from '@h3/db';
import { InMemoryTelemetry, type AgentTelemetry } from '@h3/telemetry';
import { safeRecommendationText } from './operator.js';

/**
 * `recommendation.created` carries the finding itself. The other two are
 * raw domain events the operator does not turn into a recommendation --
 * `project.budget_denied` is not in `OPERATIONAL_TRIGGER_EVENT_TYPES` at
 * all, so a webhook is the only way either reaches an operator who is not
 * watching the panel (`75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` step 2).
 */
export const NOTIFIABLE_EVENT_TYPES = [
  'recommendation.created',
  'project.budget_denied',
  'executor.unavailable',
] as const satisfies readonly DomainEvent['type'][];

export type NotifiableEventType = (typeof NOTIFIABLE_EVENT_TYPES)[number];

const notifiableEventSet = new Set<string>(NOTIFIABLE_EVENT_TYPES);

// Structured, already-short payload fields considered safe to forward
// as-is (after the same redaction pass as every other text field below).
// Deliberately narrow and per-type rather than "everything in the
// allowlisted SSE payload": this module owns its own bound instead of
// depending on `app.ts`'s SSE transport, which the 7E non-goals forbid
// changing.
const EVENT_PAYLOAD_FIELDS: Readonly<
  Record<NotifiableEventType, readonly string[]>
> = {
  'recommendation.created': [
    'recommendationId',
    'severity',
    'recommendationCode',
    'proposedActionType',
    'triggeringEventType',
  ],
  'project.budget_denied': ['reason', 'estimatedCostMicrousd'],
  'executor.unavailable': ['workflowRevisionId', 'reasonCode'],
};

function safeField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const sanitized = safeRecommendationText(value, '').slice(0, maxLength);
  return sanitized.length > 0 ? sanitized : undefined;
}

async function buildNotificationBody(
  event: DomainEvent,
  repositories: Repositories | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    eventId: event.id,
    eventType: event.type,
    occurredAt: event.occurredAt,
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.shotId ? { shotId: event.shotId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
  };

  const fields = EVENT_PAYLOAD_FIELDS[event.type as NotifiableEventType];
  for (const field of fields) {
    const value = event.payload[field];
    if (typeof value === 'string') {
      const safe = safeField(value, 240);
      if (safe) body[field] = safe;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      body[field] = value;
    }
  }

  // The finding's own prose lives on the `operational_recommendations` row,
  // not the domain event payload -- look it up so the notification reads as
  // something other than a bare identifier dump. Best-effort: without a
  // transaction, or if the row cannot be found, the body above still
  // stands on its own.
  const recommendationId = event.payload.recommendationId;
  if (
    event.type === 'recommendation.created' &&
    repositories &&
    event.projectId &&
    isUuidV7(recommendationId)
  ) {
    const recommendation =
      await repositories.operationalRecommendations.findById(
        event.tenantId,
        event.projectId,
        recommendationId,
      );
    const title = safeField(recommendation?.title, 240);
    const detail = safeField(recommendation?.detail, 2_000);
    if (title) body.title = title;
    if (detail) body.detail = detail;
  }

  return body;
}

export interface NotificationDelivery {
  deliver(body: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface WebhookNotificationDeliveryOptions {
  readonly webhookUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * POSTs a bounded JSON body to one configured webhook. Works with ntfy,
 * Slack, Discord, or a local listener without an SMTP dependency (7E step
 * 2). Callers decide whether a failure is fatal -- this class only shapes
 * the request; see `NotifyingOutboxConsumer` for the isolation rule.
 */
export class WebhookNotificationDelivery implements NotificationDelivery {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebhookNotificationDeliveryOptions) {
    this.webhookUrl = options.webhookUrl;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async deliver(body: Readonly<Record<string, unknown>>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Undici's fetch keeps the connection out of the pool until the
      // response body is read or cancelled, so an unconsumed body would
      // otherwise sit there until GC finalizes it. Drain it here, ahead of
      // both outcomes below, and swallow a cancellation failure so it can
      // never mask the real HTTP status this method reports next.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        throw new Error(
          `Notification webhook responded with HTTP ${response.status}.`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface NotifyingOutboxConsumerOptions {
  readonly inner: OutboxConsumer;
  readonly delivery: NotificationDelivery;
  readonly telemetry?: AgentTelemetry;
}

/**
 * Wraps the operator's outbox consumer with best-effort delivery.
 * Isolation rule, normative (`75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md` step
 * 2): `inner.consume()` is authoritative and its errors propagate so the
 * outbox retries the message; delivery errors are caught, recorded on a
 * span, and swallowed here, never rethrown. Retrying a message whose
 * `inner` step already committed would re-run the operator's own consumer
 * for the same event -- free today under `faux`, a second paid inference
 * call once a real provider is wired in. A missed notification is
 * recoverable from `operational_recommendations`; a duplicated paid run is
 * not.
 */
export class NotifyingOutboxConsumer implements OutboxConsumer {
  private readonly inner: OutboxConsumer;
  private readonly delivery: NotificationDelivery;
  private readonly telemetry: AgentTelemetry;

  constructor(options: NotifyingOutboxConsumerOptions) {
    this.inner = options.inner;
    this.delivery = options.delivery;
    this.telemetry = options.telemetry ?? new InMemoryTelemetry();
  }

  async consume(
    message: OutboxMessage,
    repositories?: Repositories,
  ): Promise<void> {
    await this.inner.consume(message, repositories);
    if (!notifiableEventSet.has(message.event.type)) return;

    const span = this.telemetry.startSpan('operator.notify', {
      eventType: message.event.type,
    });
    const startedAt = Date.now();
    let deliveryError: unknown;
    try {
      const body = await buildNotificationBody(message.event, repositories);
      await this.delivery.deliver(body);
      span.setStatus('ok');
    } catch (error) {
      // Isolation rule: never rethrow. Swallowing here, after recording on
      // the span above, is what keeps a notifier failure from failing this
      // outbox message.
      deliveryError = error;
      span.setStatus('error', error);
    } finally {
      span.setAttributes({
        result: deliveryError ? 'failure' : 'success',
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      span.end();
    }
  }
}
