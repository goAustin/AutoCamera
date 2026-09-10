/**
 * The one redactor for free text that is about to be persisted, served over
 * the API, or sent to a webhook.
 *
 * It exists because two kinds of text reach durable records without the API
 * having written them: a model's own conclusion (`safeRecommendationText`) and
 * a failure message from the executor or a human reviewer
 * (`redactFailureMessage`). Both used to carry their own near-identical copy
 * of these rules, which drifted -- one gained a credential rule and a URL
 * rule the other never got, and a fix to one left the other behind.
 *
 * Each rule demands evidence it is looking at the real thing. Matching any
 * `/` as a path and the bare word "prompt" as prompt content was harmless
 * while every string came from a fixed English sentence, and started mangling
 * ordinary text the moment a model's prose or an operator's note reached
 * here: "failed 3/5 times", "and/or", "1.2it/s", "the prompt was fine".
 *
 * The evidence tools already refuse to hand a model a prompt, a graph, or an
 * artifact (`packages/agent-tools/src/operational.test.ts`), and the Comfy
 * client replaces every transport failure with a fixed message rather than
 * echoing a URL or an `authorization` header
 * (`packages/comfy-client/src/index.ts`). These rules are the layer behind
 * those, not the only thing standing between a secret and the record.
 */
export interface RedactionOptions {
  /** Hard cap applied after redaction. */
  readonly maxLength: number;
  /** Returned when redaction leaves nothing. Defaults to an empty string. */
  readonly fallback?: string;
}

export function redactText(value: string, options: RedactionOptions): string {
  const redacted = value
    // An assignment -- `prompt: <text>`, `raw prompt = <text>`,
    // `"prompt": "<text>"` -- not every sentence that says the word.
    .replace(/(?:raw\s+)?prompt"?\s*[:=]\s*[^.;\n]*/gi, '[prompt redacted]')
    .replace(
      /\b(?:api[_ -]?key|secret|password|token)\s*[:=]\s*[^\s,;.]+/gi,
      '[credential redacted]',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    // Any scheme, and the whole thing, so a signed URL cannot leave its query
    // string behind. Runs before the path rule, whose replacement has no `/`.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, '[url redacted]')
    .replace(/[A-Za-z]:\\[^\s'"`]*/g, '[path redacted]')
    // A path starts at a token boundary: `/var/lib/x`, `~/.config`. A slash
    // *inside* a token is prose -- `3/5`, `and/or`, `1.2it/s` -- and a
    // relative path is not worth those false positives.
    .replace(/(?<![\w.~-])~?\/[^\s'"`]*/g, '[path redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return (redacted || options.fallback || '').slice(0, options.maxLength);
}

/**
 * A recommendation's `title` or `detail`. Reaches
 * `operational_recommendations` and, for a notifiable event, the webhook body.
 */
export function safeRecommendationText(
  value: string,
  fallback: string,
): string {
  return redactText(value, { maxLength: 2_000, fallback });
}

/**
 * A generation attempt's `failureMessage`. Reaches `attempts`, the
 * `attempt.failed` domain event, the API, and the studio's failure copy. Two
 * of its sources are outside this codebase's authorship: ComfyUI's
 * `exception_message` and a human reviewer's rejection reason.
 */
export function redactFailureMessage(message: string): string {
  return redactText(message, { maxLength: 500 });
}
