import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

async function text(relativePath: string): Promise<string> {
  return readFile(resolve(root, relativePath), 'utf8');
}

const compose = await text('infra/compose.yaml');
const pins = JSON.parse(
  await text('infra/observability/pin-manifest.json'),
) as {
  otelCollector?: string;
  tempo?: string;
  prometheus?: string;
  grafana?: string;
};
const dashboard = JSON.parse(
  await text('infra/observability/grafana/dashboards/h3-videoops.json'),
) as { panels?: { title?: string }[] };

const requiredComposeSnippets = [
  'otel-collector:',
  'tempo:',
  'prometheus:',
  'grafana:',
  'profiles: [observability]',
  'otel/opentelemetry-collector-contrib:0.136.0',
  'grafana/tempo:2.8.2',
  'prom/prometheus:v3.5.0',
  'grafana/grafana:12.1.1',
];
for (const snippet of requiredComposeSnippets) {
  if (!compose.includes(snippet)) {
    throw new Error(`Observability config is missing: ${snippet}`);
  }
}

const expectedPins = {
  otelCollector: 'otel/opentelemetry-collector-contrib:0.136.0',
  tempo: 'grafana/tempo:2.8.2',
  prometheus: 'prom/prometheus:v3.5.0',
  grafana: 'grafana/grafana:12.1.1',
};
for (const [key, value] of Object.entries(expectedPins)) {
  if (pins[key as keyof typeof expectedPins] !== value) {
    throw new Error(`Observability pin manifest mismatch: ${key}`);
  }
}

const panelTitles = new Set(
  (dashboard.panels ?? []).map((panel) => panel.title),
);
for (const title of [
  'Projects by durable status',
  'Attempts by status and executor',
  'Workflow validation outcomes',
  'Queue wait and execution duration',
  'Executor readiness',
  'Comfy reconciliation outcomes',
  'Evaluation failures',
  'Recorded compute cost (USD)',
  'Pi planning and operator runs',
  'Operator recommendations',
  'Operator output tier',
  'Active SSE connections',
]) {
  if (!panelTitles.has(title)) {
    throw new Error(`Grafana dashboard is missing panel: ${title}`);
  }
}

console.log(
  `PASS observability config: ${Object.keys(expectedPins).length} pinned services and ${panelTitles.size} dashboard panels validated.`,
);
