import { describe, expect, it } from 'vitest';
import {
  redactFailureMessage,
  redactText,
  safeRecommendationText,
} from './redact.js';

describe('safeRecommendationText', () => {
  /**
   * These are the sentences a real model writes. Every one of them was
   * mangled before the rules demanded evidence of the real thing -- which
   * went unnoticed for as long as tier 1 rarely worked, because
   * `defaultOutput()`'s fixed strings contain no slashes and never say
   * "prompt".
   */
  it.each([
    'The attempt failed 3/5 times before the executor became unavailable.',
    'Retry and/or escalate to a human reviewer.',
    'Queue depth was N/A at the time of the failure.',
    'The executor reported COMFY_UNAVAILABLE at 12/05 14:03 UTC.',
    'Throughput dropped to 2 frames/second during the run.',
    'The prompt was rejected by the validator.',
    'Check the input/output ratio, then decide.',
  ])('leaves ordinary prose alone: %s', (prose) => {
    expect(safeRecommendationText(prose, 'fallback')).toBe(prose);
  });

  it.each([
    ['an absolute path', 'Wrote /private/tmp/h3/out.mp4 then failed.'],
    ['a home path', 'Config at ~/.config/h3/settings.json is stale.'],
    ['a Windows path', String.raw`Wrote C:\Users\op\out.mp4 then failed.`],
    [
      'a signed URL',
      'Fetched https://example.com/a.mp4?sig=abc123 and failed.',
    ],
    ['a non-http scheme', 'Object s3://bucket/key.mp4 is missing.'],
  ])('still redacts %s', (_label, text) => {
    const sanitized = safeRecommendationText(text, 'fallback');
    expect(sanitized).toMatch(/\[(?:path|url) redacted\]/);
    // Nothing of the location survives.
    expect(sanitized).not.toMatch(/mp4|settings\.json|sig=|bucket/);
  });

  it('redacts prompt content behind an assignment, in either shape', () => {
    expect(
      safeRecommendationText('prompt: a cinematic shot of a cat', 'fallback'),
    ).toBe('[prompt redacted]');
    expect(
      safeRecommendationText('raw prompt = a cinematic shot', 'fallback'),
    ).toBe('[prompt redacted]');
    expect(
      safeRecommendationText('{"prompt": "a cinematic shot"}', 'fallback'),
    ).not.toContain('cinematic');
  });

  it('redacts credentials, and falls back when nothing survives', () => {
    expect(safeRecommendationText('api_key: sk-abc123', 'fallback')).toBe(
      '[credential redacted]',
    );
    expect(
      safeRecommendationText('Authorized with Bearer abc.def-123', 'fallback'),
    ).toBe('Authorized with Bearer [redacted]');
    expect(safeRecommendationText('   ', 'fallback')).toBe('fallback');
  });
});

describe('redactFailureMessage', () => {
  /**
   * Two of its sources are outside this codebase's authorship: ComfyUI's
   * `exception_message` and a human reviewer's rejection reason. Before both
   * callers shared one redactor, this one matched any `/` and the bare word
   * "prompt", and had no credential rule at all.
   */
  it.each([
    'Rejected: the hands are malformed in frames 3/5 and 4/5.',
    'Bad output and/or wrong aspect ratio; re-run with the v2 workflow.',
    'Operator note: the prompt was fine, the checkpoint was wrong.',
    'Sampling collapsed at 1.2it/s after the allocator failed',
    'mat1 and mat2 shapes cannot be multiplied (77x768 and 1024x320)',
  ])('leaves an executor error or a reviewer note readable: %s', (text) => {
    expect(redactFailureMessage(text)).toBe(text);
  });

  it('redacts a credential a reviewer pasted, which it used to pass through', () => {
    expect(
      redactFailureMessage('Used the wrong key, api_key: sk-live-abc123 now.'),
    ).toBe('Used the wrong key, [credential redacted] now.');
  });

  it('still redacts what ComfyUI leaks from the GPU host', () => {
    expect(
      redactFailureMessage(
        "[Errno 2] No such file or directory: '/workspace/ComfyUI/models/vae/v.safetensors'",
      ),
    ).toBe("[Errno 2] No such file or directory: '[path redacted]'");
    expect(
      redactFailureMessage(
        'Downloader: failed to fetch https://hf.co/org/m.safetensors',
      ),
    ).toBe('Downloader: failed to fetch [url redacted]');
  });

  it('caps at 500 characters and has no fallback of its own', () => {
    expect(redactFailureMessage('x'.repeat(600))).toHaveLength(500);
    // Unlike a recommendation, an empty failure message is simply absent.
    expect(redactFailureMessage('   ')).toBe('');
  });
});

describe('redactText', () => {
  it('applies the caller cap and fallback, and nothing else differs', () => {
    const leaky = 'Token at /var/lib/h3/out.mp4 with Bearer abc123';
    // One set of rules; the wrappers differ only in cap and fallback.
    expect(redactText(leaky, { maxLength: 2_000 })).toBe(
      safeRecommendationText(leaky, 'unused'),
    );
    expect(redactText(leaky, { maxLength: 500 })).toBe(
      redactFailureMessage(leaky),
    );
    expect(redactText('', { maxLength: 10, fallback: 'empty' })).toBe('empty');
    expect(redactText('abcdefghijkl', { maxLength: 4 })).toBe('abcd');
  });
});
