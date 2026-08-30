import { describe, expect, it } from 'vitest';
import { InMemoryTelemetry, OpenTelemetryTelemetry } from './index.js';

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
});
