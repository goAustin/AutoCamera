import editorFixture from '../../../workflows/minimax-h3/editor.json';
import apiFixture from '../../../workflows/minimax-h3/api.json';
import type { WorkflowGraph } from './api.js';

export const MINIMAX_H3_PROFILE_ID = 'minimax-h3-t2va-preview';
export const MINIMAX_H3_PROFILE_VERSION = '1';
export const MINIMAX_H3_SUBGRAPH_ID = '79dd8a95-ce9d-4c14-b264-2162e8bec5ce';
export const MINIMAX_H3_DEFAULT_WIDTH = 960;
export const MINIMAX_H3_DEFAULT_HEIGHT = 544;
export const MINIMAX_H3_DEFAULT_DURATION_SECONDS = 5;
export const MINIMAX_H3_DEFAULT_STEPS = 20;
export const MINIMAX_H3_FPS = 24;
export const MINIMAX_H3_MODEL_FILES = {
  diffusionModel: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  textEncoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
} as const;

export interface FakeWorkflowSettings {
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly seed: number;
}

export const DEFAULT_FAKE_WORKFLOW_SETTINGS: FakeWorkflowSettings = {
  prompt:
    'A polished product moves through a cool blue studio with natural stereo sound, smooth camera motion, and a confident premium finish.',
  width: MINIMAX_H3_DEFAULT_WIDTH,
  height: MINIMAX_H3_DEFAULT_HEIGHT,
  durationSeconds: MINIMAX_H3_DEFAULT_DURATION_SECONDS,
  seed: 42,
};

export interface FakeWorkflowGraphs {
  readonly editorGraph: WorkflowGraph;
  readonly apiGraph: WorkflowGraph;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneGraph(value: unknown): WorkflowGraph {
  return structuredClone(value) as WorkflowGraph;
}

function allEditorNodes(graph: WorkflowGraph): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  if (Array.isArray(graph.nodes)) {
    nodes.push(...graph.nodes.filter(isRecord));
  }
  const definitions = isRecord(graph.definitions)
    ? graph.definitions
    : undefined;
  if (definitions && Array.isArray(definitions.subgraphs)) {
    for (const subgraph of definitions.subgraphs) {
      if (!isRecord(subgraph) || !Array.isArray(subgraph.nodes)) continue;
      nodes.push(...subgraph.nodes.filter(isRecord));
    }
  }
  return nodes;
}

function setWidget(
  node: Record<string, unknown>,
  index: number,
  value: unknown,
): void {
  const values = Array.isArray(node.widgets_values)
    ? [...node.widgets_values]
    : [];
  values[index] = value;
  node.widgets_values = values;
}

function setNamedWidget(
  node: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  const named = isRecord(node.widgets_values_named)
    ? { ...node.widgets_values_named }
    : {};
  named[name] = value;
  node.widgets_values_named = named;
}

function nodeType(node: Record<string, unknown>): string | undefined {
  return typeof node.type === 'string' ? node.type : undefined;
}

function apiNodes(graph: WorkflowGraph): Record<string, unknown>[] {
  return Object.values(graph).filter(isRecord);
}

function apiNodeByClass(
  graph: WorkflowGraph,
  classType: string,
): Record<string, unknown> | undefined {
  return apiNodes(graph).find((node) => node.class_type === classType);
}

function setApiInput(
  graph: WorkflowGraph,
  classType: string,
  input: string,
  value: unknown,
): void {
  const node = apiNodeByClass(graph, classType);
  if (!node) return;
  const inputs = isRecord(node.inputs) ? { ...node.inputs } : {};
  inputs[input] = value;
  node.inputs = inputs;
}

export function durationToFrames(durationSeconds: number): number {
  return 17 * Math.ceil((durationSeconds * MINIMAX_H3_FPS - 5) / 17) + 5;
}

export function buildFakeWorkflowGraphs(
  settings: FakeWorkflowSettings,
): FakeWorkflowGraphs {
  const editorGraph = cloneGraph(editorFixture);
  const apiGraph = cloneGraph(apiFixture);
  const editorNodes = allEditorNodes(editorGraph);
  const subgraph = editorNodes.find(
    (node) => nodeType(node) === MINIMAX_H3_SUBGRAPH_ID,
  );
  if (subgraph) {
    for (const [index, value] of [
      settings.prompt,
      settings.width,
      settings.height,
      settings.durationSeconds,
      settings.seed,
    ].entries()) {
      setWidget(subgraph, index, value);
    }
    setNamedWidget(subgraph, 'prompt', settings.prompt);
    setNamedWidget(subgraph, 'width', settings.width);
    setNamedWidget(subgraph, 'height', settings.height);
    setNamedWidget(subgraph, 'value_1', settings.durationSeconds);
    setNamedWidget(subgraph, 'noise_seed', settings.seed);
  }
  const nestedH3 = editorNodes.find(
    (node) => nodeType(node) === 'MiniMaxH3ImageToVideo',
  );
  if (nestedH3) {
    const frames = durationToFrames(settings.durationSeconds);
    setWidget(nestedH3, 0, settings.prompt);
    setWidget(nestedH3, 1, settings.width);
    setWidget(nestedH3, 2, settings.height);
    setWidget(nestedH3, 3, frames);
    setNamedWidget(nestedH3, 'prompt', settings.prompt);
    setNamedWidget(nestedH3, 'width', settings.width);
    setNamedWidget(nestedH3, 'height', settings.height);
    setNamedWidget(nestedH3, 'length', frames);
  }
  const nestedNoise = editorNodes.find(
    (node) => nodeType(node) === 'RandomNoise',
  );
  if (nestedNoise) {
    setWidget(nestedNoise, 0, settings.seed);
    setNamedWidget(nestedNoise, 'noise_seed', settings.seed);
  }

  setApiInput(apiGraph, 'MiniMaxH3ImageToVideo', 'prompt', settings.prompt);
  setApiInput(apiGraph, 'MiniMaxH3ImageToVideo', 'width', settings.width);
  setApiInput(apiGraph, 'MiniMaxH3ImageToVideo', 'height', settings.height);
  setApiInput(
    apiGraph,
    'MiniMaxH3ImageToVideo',
    'length',
    durationToFrames(settings.durationSeconds),
  );
  setApiInput(apiGraph, 'RandomNoise', 'noise_seed', settings.seed);
  setApiInput(apiGraph, 'BasicScheduler', 'steps', MINIMAX_H3_DEFAULT_STEPS);
  setApiInput(apiGraph, 'CreateVideo', 'fps', MINIMAX_H3_FPS);

  return { editorGraph, apiGraph };
}

function namedValue(
  node: Record<string, unknown> | undefined,
  name: string,
): unknown {
  const named =
    node && isRecord(node.widgets_values_named)
      ? node.widgets_values_named[name]
      : undefined;
  return named;
}

function inputValue(
  graph: WorkflowGraph,
  classType: string,
  input: string,
): unknown {
  const node = apiNodeByClass(graph, classType);
  return node && isRecord(node.inputs) ? node.inputs[input] : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function extractFakeWorkflowSettings(
  editorGraph: WorkflowGraph,
  apiGraph: WorkflowGraph | undefined,
  fallback: FakeWorkflowSettings,
): FakeWorkflowSettings {
  const editorNodes = allEditorNodes(editorGraph);
  const subgraph = editorNodes.find(
    (node) => nodeType(node) === MINIMAX_H3_SUBGRAPH_ID,
  );
  const prompt = inputValue(apiGraph ?? {}, 'MiniMaxH3ImageToVideo', 'prompt');
  const width = inputValue(apiGraph ?? {}, 'MiniMaxH3ImageToVideo', 'width');
  const height = inputValue(apiGraph ?? {}, 'MiniMaxH3ImageToVideo', 'height');
  const seed = inputValue(apiGraph ?? {}, 'RandomNoise', 'noise_seed');
  return {
    prompt:
      typeof prompt === 'string'
        ? prompt
        : typeof namedValue(subgraph, 'prompt') === 'string'
          ? (namedValue(subgraph, 'prompt') as string)
          : fallback.prompt,
    width: finiteNumber(
      width,
      finiteNumber(namedValue(subgraph, 'width'), fallback.width),
    ),
    height: finiteNumber(
      height,
      finiteNumber(namedValue(subgraph, 'height'), fallback.height),
    ),
    durationSeconds: finiteNumber(
      namedValue(subgraph, 'value_1'),
      fallback.durationSeconds,
    ),
    seed: finiteNumber(
      seed,
      finiteNumber(namedValue(subgraph, 'noise_seed'), fallback.seed),
    ),
  };
}
