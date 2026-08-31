import { describe, expect, it } from 'vitest';
import {
  CORE_METRIC_DEFINITIONS,
  CORE_METRIC_NAMES,
  InMemoryTelemetry,
  MetricLabelError,
  MetricsRegistry,
  OpenTelemetryTelemetry,
  BufferedTelemetry,
  sanitizeTelemetryAttributes,
} from './index.js';

describe('agent telemetry', () => {
  it('records typed parent-child spans and events without payloads', async () => {
    const telemetry = new InMemoryTelemetry();
    const root = telemetry.startSpan('agent.run', { provider: 'faux' });
    const child = telemetry.startSpan(
      'agent.tool',
      { tool: 'get_video_project' },
      root,
    );
    child.addEvent('policy.denial', { code: 'PROJECT_SCOPE_DENIED' });
    child.setStatus('error');
    child.end();
    root.end();

    expect(await telemetry.flush()).toBeUndefined();
    expect(telemetry.getSpans()).toMatchObject([
      { name: 'agent.run', ended: true },
      {
        name: 'agent.tool',
        parentName: 'agent.run',
        status: 'error',
        ended: true,
        events: [{ name: 'policy.denial' }],
      },
    ]);
  });

  it('isolates exporter failure', async () => {
    const telemetry = new OpenTelemetryTelemetry({
      flush: async () => {
        throw new Error('exporter unavailable');
      },
    });
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });

  it('keeps trace parents and removes payload-shaped attributes', () => {
    const telemetry = new InMemoryTelemetry();
    const root = telemetry.startRootSpan('project.create', {
      status: 'draft',
      projectId: '00000000-0000-7000-8000-000000000001',
      prompt: 'A private storyboard prompt',
    });
    const child = telemetry.startSpan(
      'agent.tool',
      {
        tool: 'get_video_project',
        graph: { nodes: [] } as unknown as string,
        authorization: 'Bearer fixture-token',
      },
      root,
    );
    child.end();
    root.end();

    const spans = telemetry.getSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0]?.traceId).toBe(spans[1]?.traceId);
    expect(spans[1]?.parentSpanId).toBe(spans[0]?.spanId);
    expect(spans[0]?.attributes).toEqual({ status: 'draft' });
    expect(spans[1]?.attributes).toEqual({ tool: 'get_video_project' });
    expect(
      sanitizeTelemetryAttributes({
        status: 'ok',
        graphJson: '{}',
        signedUrl: 'https://private.example.test/download?sig=fixture',
        count: 2,
      }),
    ).toEqual({ status: 'ok', count: 2 });
  });

  it('exposes every core metric family with exact bounded labels', () => {
    expect(CORE_METRIC_DEFINITIONS.map(({ name }) => name)).toEqual(
      CORE_METRIC_NAMES,
    );
    const metrics = new MetricsRegistry();
    metrics.increment('video_projects_total', { status: 'draft' });
    metrics.observe(
      'video_generation_queue_wait_seconds',
      { executor_mode: 'fake' },
      0.25,
    );
    metrics.set('video_sse_connections', {}, 1);

    expect(metrics.renderPrometheus()).toContain(
      'video_projects_total{status="draft"} 1',
    );
    expect(metrics.renderPrometheus()).toContain(
      'video_generation_queue_wait_seconds_bucket{executor_mode="fake",le="1"} 1',
    );
    expect(() =>
      metrics.increment('video_projects_total', {
        status: 'draft',
        project_id: 'unbounded-id',
      } as never),
    ).toThrow(MetricLabelError);
    expect(() =>
      metrics.increment('video_executor_ready', { executor_mode: 'gpu-a100' }),
    ).toThrow(MetricLabelError);
  });

  it('isolates an OTLP exporter failure and never rejects flush', async () => {
    const telemetry = new BufferedTelemetry({
      endpoint: 'http://collector.invalid',
      fetchImpl: async () => {
        throw new Error('collector unavailable');
      },
    });
    const span = telemetry.startRootSpan('comfy.observe', {
      executorMode: 'fake',
      response: 'do not export',
    });
    span.end();
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(telemetry.getSpans()[0]?.attributes).toEqual({
      executorMode: 'fake',
    });
  });
});
