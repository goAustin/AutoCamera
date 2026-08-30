import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson, jsonByteLength } from './canonical.js';

export const MINIMAX_H3_PROFILE_ID = 'minimax-h3-t2va-preview' as const;
export const MINIMAX_H3_PROFILE_VERSION = '1' as const;
export const MINIMAX_H3_TEMPLATE_PIN =
  'd3b4a9e89573162b005961865164c18c8ae2206b' as const;
export const MINIMAX_H3_BACKEND_PIN =
  '8a33128f2f8c5585c57486c07de481241e70a39c' as const;
export const MINIMAX_H3_FRONTEND_PIN =
  '3697a1bc3ba7f6b98a1ead888721f7676b536eb5' as const;
export const MINIMAX_H3_MODEL_REPOSITORY = 'MiniMax-AI/MiniMax-H3' as const;
export const MINIMAX_H3_MODEL_REPOSITORY_PIN =
  'd21241f0a4b3acbb34c97dae47fa417b7065e438' as const;
export const MINIMAX_H3_SUBGRAPH_ID =
  '79dd8a95-ce9d-4c14-b264-2162e8bec5ce' as const;

export const MINIMAX_H3_DEFAULT_WIDTH = 960 as const;
export const MINIMAX_H3_DEFAULT_HEIGHT = 544 as const;
export const MINIMAX_H3_FPS = 24 as const;
export const MINIMAX_H3_DEFAULT_DURATION_SECONDS = 5 as const;
export const MINIMAX_H3_DEFAULT_STEPS = 20 as const;
export const MINIMAX_H3_MAX_SHORT_EDGE = 768 as const;
export const MINIMAX_H3_MAX_LONG_EDGE = 1344 as const;
export const MINIMAX_H3_MAX_DURATION_SECONDS = 15 as const;

export const MINIMAX_H3_MODEL_FILES = {
  diffusionModel: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  textEncoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  turboLora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
} as const;

export const MINIMAX_H3_REQUIRED_API_NODE_CLASSES = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'MiniMaxH3ImageToVideo',
  'RandomNoise',
  'BasicScheduler',
  'KSamplerSelect',
  'BasicGuider',
  'SamplerCustomAdvanced',
  'VAEDecode',
  'VAEDecodeAudio',
  'CreateVideo',
  'SaveVideo',
] as const;

const MINIMAX_H3_OPTIONAL_API_NODE_CLASSES = ['LoraLoaderModelOnly'] as const;

const MINIMAX_H3_EDITOR_HELPER_NODE_TYPES = [
  'ResolutionSelector',
  'MarkdownNote',
  'ComfyMathExpression',
  'PrimitiveFloat',
  'ComfySwitchNode',
  'PrimitiveInt',
  'PrimitiveBoolean',
  'LoraLoaderModelOnly',
] as const;

export const MINIMAX_H3_ALLOWED_EDITOR_NODE_TYPES = [
  ...MINIMAX_H3_REQUIRED_API_NODE_CLASSES,
  ...MINIMAX_H3_EDITOR_HELPER_NODE_TYPES,
  MINIMAX_H3_SUBGRAPH_ID,
] as const;

export const MINIMAX_H3_ALLOWED_API_NODE_CLASSES = [
  ...MINIMAX_H3_REQUIRED_API_NODE_CLASSES,
  ...MINIMAX_H3_OPTIONAL_API_NODE_CLASSES,
] as const;

export interface MinimaxH3CompatibilityManifest {
  readonly profileId: typeof MINIMAX_H3_PROFILE_ID;
  readonly profileVersion: typeof MINIMAX_H3_PROFILE_VERSION;
  readonly sourceTemplate: {
    readonly repository: 'Comfy-Org/workflow_templates';
    readonly ref: typeof MINIMAX_H3_TEMPLATE_PIN;
    readonly path: 'templates/video_minimax_h3_t2v.json';
  };
  readonly sourceBackend: {
    readonly repository: 'Comfy-Org/ComfyUI';
    readonly ref: typeof MINIMAX_H3_BACKEND_PIN;
  };
  readonly sourceFrontend: {
    readonly repository: 'Comfy-Org/ComfyUI_frontend';
    readonly ref: typeof MINIMAX_H3_FRONTEND_PIN;
  };
  readonly sourceModel: {
    readonly repository: typeof MINIMAX_H3_MODEL_REPOSITORY;
    readonly ref: typeof MINIMAX_H3_MODEL_REPOSITORY_PIN;
  };
  readonly editorSubgraphId: typeof MINIMAX_H3_SUBGRAPH_ID;
  readonly mode: 't2va';
  readonly defaults: {
    readonly width: typeof MINIMAX_H3_DEFAULT_WIDTH;
    readonly height: typeof MINIMAX_H3_DEFAULT_HEIGHT;
    readonly fps: typeof MINIMAX_H3_FPS;
    readonly durationSeconds: typeof MINIMAX_H3_DEFAULT_DURATION_SECONDS;
    readonly steps: typeof MINIMAX_H3_DEFAULT_STEPS;
    readonly turbo: false;
    readonly audioSampleRate: 32000;
    readonly audioChannels: 2;
  };
  readonly modelFiles: typeof MINIMAX_H3_MODEL_FILES;
  readonly requiredApiNodeClasses: typeof MINIMAX_H3_REQUIRED_API_NODE_CLASSES;
  readonly allowedApiNodeClasses: typeof MINIMAX_H3_ALLOWED_API_NODE_CLASSES;
  readonly allowedEditorNodeTypes: typeof MINIMAX_H3_ALLOWED_EDITOR_NODE_TYPES;
  readonly outputPrefixPolicy: 'attempt-scoped-server-normalized';
}

export const MINIMAX_H3_COMPATIBILITY_MANIFEST: MinimaxH3CompatibilityManifest =
  {
    profileId: MINIMAX_H3_PROFILE_ID,
    profileVersion: MINIMAX_H3_PROFILE_VERSION,
    sourceTemplate: {
      repository: 'Comfy-Org/workflow_templates',
      ref: MINIMAX_H3_TEMPLATE_PIN,
      path: 'templates/video_minimax_h3_t2v.json',
    },
    sourceBackend: {
      repository: 'Comfy-Org/ComfyUI',
      ref: MINIMAX_H3_BACKEND_PIN,
    },
    sourceFrontend: {
      repository: 'Comfy-Org/ComfyUI_frontend',
      ref: MINIMAX_H3_FRONTEND_PIN,
    },
    sourceModel: {
      repository: MINIMAX_H3_MODEL_REPOSITORY,
      ref: MINIMAX_H3_MODEL_REPOSITORY_PIN,
    },
    editorSubgraphId: MINIMAX_H3_SUBGRAPH_ID,
    mode: 't2va',
    defaults: {
      width: MINIMAX_H3_DEFAULT_WIDTH,
      height: MINIMAX_H3_DEFAULT_HEIGHT,
      fps: MINIMAX_H3_FPS,
      durationSeconds: MINIMAX_H3_DEFAULT_DURATION_SECONDS,
      steps: MINIMAX_H3_DEFAULT_STEPS,
      turbo: false,
      audioSampleRate: 32000,
      audioChannels: 2,
    },
    modelFiles: MINIMAX_H3_MODEL_FILES,
    requiredApiNodeClasses: MINIMAX_H3_REQUIRED_API_NODE_CLASSES,
    allowedApiNodeClasses: MINIMAX_H3_ALLOWED_API_NODE_CLASSES,
    allowedEditorNodeTypes: MINIMAX_H3_ALLOWED_EDITOR_NODE_TYPES,
    outputPrefixPolicy: 'attempt-scoped-server-normalized',
  };

export type WorkflowValidationCode =
  | 'GRAPH_SCHEMA_INVALID'
  | 'GRAPH_EXPORT_MISMATCH'
  | 'PROFILE_UNSUPPORTED'
  | 'NODE_CLASS_MISSING'
  | 'MODEL_MISSING'
  | 'PARAMETER_MISMATCH'
  | 'OUTPUT_CONTRACT_INVALID'
  | 'DIMENSION_INVALID'
  | 'DURATION_GRID_INVALID'
  | 'EXECUTOR_UNAVAILABLE'
  | 'CAPABILITY_DRIFT'
  | 'UNSAFE_NODE';

export interface WorkflowValidationIssue {
  readonly code: WorkflowValidationCode;
  readonly message: string;
}

export interface MinimaxH3EffectiveParameters {
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly requestedDurationSeconds: number;
  readonly frames: number;
  readonly actualDurationSeconds: number;
  readonly seed: number;
  readonly steps: number;
  readonly fps: number;
  readonly turbo: false;
  readonly nativeAudio: true;
  readonly diffusionModel: string;
  readonly textEncoder: string;
  readonly videoVae: string;
  readonly audioVae: string;
  readonly outputPrefix: string;
}

export interface MinimaxH3ValidationResult {
  readonly valid: boolean;
  readonly profileId: typeof MINIMAX_H3_PROFILE_ID;
  readonly profileVersion: typeof MINIMAX_H3_PROFILE_VERSION;
  readonly errors: readonly WorkflowValidationIssue[];
  readonly executionParameters: Readonly<Record<string, unknown>>;
  readonly effectiveParameters?: MinimaxH3EffectiveParameters;
  readonly executorFingerprint?: string;
}

export interface MinimaxH3ValidationInput {
  readonly editorGraph: unknown;
  readonly apiGraph: unknown;
  readonly profileId?: string;
  readonly profileVersion?: string;
  /** The normalized `/object_info` response, when an executor is available. */
  readonly objectInfo?: unknown;
  /** Require executor capability evidence instead of local profile validation. */
  readonly requireExecutor?: boolean;
}

interface EditorNode {
  readonly id: string;
  readonly type: string;
  readonly widgetsValues?: readonly unknown[];
  readonly widgetsNamed?: Readonly<Record<string, unknown>>;
}

interface ApiNode {
  readonly id: string;
  readonly classType: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

type ApiGraph = Readonly<Record<string, ApiNode>>;

interface EditorValues {
  readonly prompt?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly durationSeconds?: unknown;
  readonly frames?: unknown;
  readonly seed?: unknown;
  readonly steps?: unknown;
  readonly fps?: unknown;
  readonly turbo?: unknown;
  readonly diffusionModel?: unknown;
  readonly textEncoder?: unknown;
  readonly videoVae?: unknown;
  readonly audioVae?: unknown;
  readonly outputPrefix?: unknown;
}

interface ApiValues {
  readonly prompt?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly frames?: unknown;
  readonly seed?: unknown;
  readonly steps?: unknown;
  readonly fps?: unknown;
  readonly turbo?: unknown;
  readonly diffusionModel?: unknown;
  readonly textEncoder?: unknown;
  readonly videoVae?: unknown;
  readonly audioVae?: unknown;
  readonly outputPrefix?: unknown;
}

interface ParsedGraphs {
  readonly editor: readonly EditorNode[] | undefined;
  readonly api: ApiGraph | undefined;
}

const MAX_GRAPH_BYTES = 1_048_576;
const MAX_PROMPT_LENGTH = 32_000;
const MAX_OUTPUT_PREFIX_LENGTH = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

function addIssue(
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
  code: WorkflowValidationCode,
  message: string,
): void {
  const key = `${code}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  errors.push({ code, message });
}

function safeString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function safeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function graphSizeIsValid(
  value: unknown,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
  label: string,
): boolean {
  try {
    if (jsonByteLength(value) > MAX_GRAPH_BYTES) {
      addIssue(
        errors,
        seen,
        'GRAPH_SCHEMA_INVALID',
        `${label} exceeds the 1 MiB JSON size limit.`,
      );
      return false;
    }
    return true;
  } catch {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      `${label} is not canonical JSON.`,
    );
    return false;
  }
}

function nodeId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}

function parseEditorNode(
  value: unknown,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): EditorNode | undefined {
  if (!isPlainRecord(value)) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      'Every editor graph node must be an object.',
    );
    return undefined;
  }
  const id = nodeId(value.id);
  const type = value.type;
  if (!id || typeof type !== 'string' || !type.trim()) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      'Every editor graph node requires an identifier and type.',
    );
    return undefined;
  }
  const widgetsValues = value.widgets_values;
  if (widgetsValues !== undefined && !Array.isArray(widgetsValues)) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      `Editor node ${type} has invalid widget values.`,
    );
  }
  const widgetsNamed = value.widgets_values_named;
  if (widgetsNamed !== undefined && !isPlainRecord(widgetsNamed)) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      `Editor node ${type} has invalid named widget values.`,
    );
  }
  if (!MINIMAX_H3_ALLOWED_EDITOR_NODE_TYPES.includes(type as never)) {
    addIssue(
      errors,
      seen,
      'UNSAFE_NODE',
      `Editor node class ${type} is not allowed by the pinned H3 profile.`,
    );
  }
  return {
    id,
    type,
    ...(Array.isArray(widgetsValues) ? { widgetsValues } : {}),
    ...(isPlainRecord(widgetsNamed)
      ? { widgetsNamed: widgetsNamed as Readonly<Record<string, unknown>> }
      : {}),
  };
}

function nestedEditorNodes(value: unknown): readonly unknown[] {
  if (!isPlainRecord(value)) return [];
  const definitions = value.definitions;
  if (!isPlainRecord(definitions) || !Array.isArray(definitions.subgraphs)) {
    return [];
  }
  return definitions.subgraphs.flatMap((subgraph) => {
    if (!isPlainRecord(subgraph)) return [];
    return Array.isArray(subgraph.nodes) ? subgraph.nodes : [];
  });
}

function parseEditorGraph(
  value: unknown,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): readonly EditorNode[] | undefined {
  if (!isPlainRecord(value)) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      'The editor graph must be a JSON object.',
    );
    return undefined;
  }
  if (!graphSizeIsValid(value, errors, seen, 'Editor graph')) return undefined;
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      'The editor graph must contain at least one node.',
    );
    return undefined;
  }
  const rawNodes = [...value.nodes, ...nestedEditorNodes(value)];
  const nodes: EditorNode[] = [];
  const ids = new Set<string>();
  for (const rawNode of rawNodes) {
    const node = parseEditorNode(rawNode, errors, seen);
    if (!node) continue;
    if (ids.has(node.id)) {
      addIssue(
        errors,
        seen,
        'GRAPH_SCHEMA_INVALID',
        `Editor node identifier ${node.id} is duplicated.`,
      );
      continue;
    }
    ids.add(node.id);
    nodes.push(node);
  }
  return nodes;
}

function isConnection(value: unknown): value is readonly [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    value[0].trim().length > 0 &&
    safeInteger(value[1]) &&
    value[1] >= 0
  );
}

function parseApiGraph(
  value: unknown,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): ApiGraph | undefined {
  if (!isPlainRecord(value)) {
    addIssue(
      errors,
      seen,
      'GRAPH_SCHEMA_INVALID',
      'The API execution graph must be a JSON object.',
    );
    return undefined;
  }
  if (!graphSizeIsValid(value, errors, seen, 'API execution graph')) {
    return undefined;
  }
  const graph: Record<string, ApiNode> = {};
  for (const [id, rawNode] of Object.entries(value)) {
    if (!isPlainRecord(rawNode)) {
      addIssue(
        errors,
        seen,
        'GRAPH_SCHEMA_INVALID',
        `API node ${id} must be an object.`,
      );
      continue;
    }
    const classType = rawNode.class_type;
    const inputs = rawNode.inputs;
    if (
      typeof classType !== 'string' ||
      !classType.trim() ||
      !isPlainRecord(inputs)
    ) {
      addIssue(
        errors,
        seen,
        'GRAPH_SCHEMA_INVALID',
        `API node ${id} requires class_type and inputs.`,
      );
      continue;
    }
    if (!MINIMAX_H3_ALLOWED_API_NODE_CLASSES.includes(classType as never)) {
      addIssue(
        errors,
        seen,
        'UNSAFE_NODE',
        `API node class ${classType} is not allowed by the pinned H3 profile.`,
      );
    }
    for (const input of Object.values(inputs)) {
      if (Array.isArray(input) && !isConnection(input)) {
        addIssue(
          errors,
          seen,
          'GRAPH_SCHEMA_INVALID',
          `API node ${classType} contains an invalid link value.`,
        );
      }
    }
    graph[id] = {
      id,
      classType,
      inputs: inputs as Readonly<Record<string, unknown>>,
    };
  }
  for (const node of Object.values(graph)) {
    for (const input of Object.values(node.inputs)) {
      if (!isConnection(input)) continue;
      if (!graph[input[0]]) {
        addIssue(
          errors,
          seen,
          'OUTPUT_CONTRACT_INVALID',
          `API node ${node.classType} references a missing link target.`,
        );
      }
    }
  }
  return graph;
}

function parseGraphs(
  input: MinimaxH3ValidationInput,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): ParsedGraphs {
  return {
    editor: parseEditorGraph(input.editorGraph, errors, seen),
    api: parseApiGraph(input.apiGraph, errors, seen),
  };
}

function validateEditorNodeClasses(
  nodes: readonly EditorNode[],
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): void {
  for (const classType of MINIMAX_H3_REQUIRED_API_NODE_CLASSES) {
    if (!nodes.some((node) => node.type === classType)) {
      addIssue(
        errors,
        seen,
        'NODE_CLASS_MISSING',
        `The editor graph is missing required node class ${classType}.`,
      );
    }
  }
}

function widgetValue(
  node: EditorNode,
  namedKeys: readonly string[],
  positionalIndex: number,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): unknown {
  const namedKey = namedKeys.find((key) =>
    Object.hasOwn(node.widgetsNamed ?? {}, key),
  );
  const namedValue = namedKey
    ? (node.widgetsNamed as Record<string, unknown>)[namedKey]
    : undefined;
  const positionalValue = node.widgetsValues?.[positionalIndex];
  if (
    namedKey &&
    positionalValue !== undefined &&
    !sameJson(namedValue, positionalValue)
  ) {
    addIssue(
      errors,
      seen,
      'GRAPH_EXPORT_MISMATCH',
      `Editor node ${node.type} has disagreeing named and positional values.`,
    );
  }
  return namedKey ? namedValue : positionalValue;
}

function findNode(
  nodes: readonly EditorNode[],
  type: string,
): EditorNode | undefined {
  return nodes.find((node) => node.type === type);
}

function findSettingsNode(
  nodes: readonly EditorNode[],
): EditorNode | undefined {
  return (
    nodes.find(
      (node) =>
        node.type === MINIMAX_H3_SUBGRAPH_ID &&
        Object.hasOwn(node.widgetsNamed ?? {}, 'prompt'),
    ) ??
    nodes.find(
      (node) =>
        node.type === 'MiniMaxH3ImageToVideo' &&
        Object.hasOwn(node.widgetsNamed ?? {}, 'prompt'),
    ) ??
    nodes.find((node) => Object.hasOwn(node.widgetsNamed ?? {}, 'prompt'))
  );
}

function editorValues(
  nodes: readonly EditorNode[],
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): EditorValues {
  const settings = findSettingsNode(nodes);
  if (!settings) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The editor graph has no effective MiniMax H3 parameter node.',
    );
    return {};
  }
  const prompt = widgetValue(settings, ['prompt'], 0, errors, seen);
  const width = widgetValue(settings, ['width'], 1, errors, seen);
  const height = widgetValue(settings, ['height'], 2, errors, seen);
  const promotedSubgraph = settings.type === MINIMAX_H3_SUBGRAPH_ID;
  const duration = widgetValue(
    settings,
    ['value_1', 'duration', 'durationSeconds'],
    promotedSubgraph ? 3 : -1,
    errors,
    seen,
  );
  const length = widgetValue(
    settings,
    ['length'],
    promotedSubgraph ? -1 : 3,
    errors,
    seen,
  );
  const seed = widgetValue(settings, ['noise_seed', 'seed'], 4, errors, seen);
  const diffusionModel = widgetValue(
    settings,
    ['unet_name', 'diffusion_model'],
    5,
    errors,
    seen,
  );
  const textEncoder = widgetValue(
    settings,
    ['clip_name', 'text_encoder'],
    6,
    errors,
    seen,
  );
  const videoVae = widgetValue(
    settings,
    ['vae_name', 'video_vae'],
    7,
    errors,
    seen,
  );
  const audioVae = widgetValue(
    settings,
    ['vae_name_1', 'audio_vae'],
    8,
    errors,
    seen,
  );
  const turbo = widgetValue(
    settings,
    ['value', 'turbo_mode', 'turbo'],
    9,
    errors,
    seen,
  );
  const outputNode = findNode(nodes, 'SaveVideo');
  const outputPrefix = outputNode
    ? widgetValue(outputNode, ['filename_prefix'], 0, errors, seen)
    : undefined;
  const createVideo = findNode(nodes, 'CreateVideo');
  const fps = createVideo
    ? widgetValue(createVideo, ['fps'], 0, errors, seen)
    : undefined;

  const primitiveSteps = nodes
    .filter((node) => node.type === 'PrimitiveInt')
    .map((node) => widgetValue(node, ['value'], 0, errors, seen))
    .filter(safeInteger);
  // The pinned subgraph stores turbo steps in the outer node's final widget
  // slot. It is not the effective non-turbo step count; that value is carried
  // by the selected PrimitiveInt branch.
  const directSteps = widgetValue(settings, ['steps'], -1, errors, seen);
  const steps =
    directSteps !== undefined
      ? directSteps
      : (primitiveSteps.find((value) => value === MINIMAX_H3_DEFAULT_STEPS) ??
        primitiveSteps[0]);

  return {
    prompt,
    width,
    height,
    ...(duration !== undefined
      ? { durationSeconds: duration }
      : length !== undefined
        ? { frames: length }
        : {}),
    seed,
    steps,
    fps,
    turbo,
    diffusionModel,
    textEncoder,
    videoVae,
    audioVae,
    outputPrefix,
  };
}

function apiNodesByClass(
  graph: ApiGraph,
  classType: string,
): readonly ApiNode[] {
  return Object.values(graph).filter((node) => node.classType === classType);
}

function oneApiNode(
  graph: ApiGraph,
  classType: string,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): ApiNode | undefined {
  const nodes = apiNodesByClass(graph, classType);
  if (nodes.length !== 1) {
    addIssue(
      errors,
      seen,
      'NODE_CLASS_MISSING',
      `The API graph must contain exactly one ${classType} node.`,
    );
    return nodes[0];
  }
  return nodes[0];
}

function literalInput(
  node: ApiNode | undefined,
  name: string,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): unknown {
  if (!node || !Object.hasOwn(node.inputs, name)) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      `The API graph is missing the ${name} input.`,
    );
    return undefined;
  }
  const value = node.inputs[name];
  if (isConnection(value)) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      `The API graph ${name} input must be a literal effective value.`,
    );
    return undefined;
  }
  if (isPlainRecord(value) && Object.hasOwn(value, '__value__')) {
    return value.__value__;
  }
  return value;
}

function apiValues(
  graph: ApiGraph,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): ApiValues {
  const h3 = oneApiNode(graph, 'MiniMaxH3ImageToVideo', errors, seen);
  const noise = oneApiNode(graph, 'RandomNoise', errors, seen);
  const scheduler = oneApiNode(graph, 'BasicScheduler', errors, seen);
  const createVideo = oneApiNode(graph, 'CreateVideo', errors, seen);
  const output = oneApiNode(graph, 'SaveVideo', errors, seen);
  const unet = oneApiNode(graph, 'UNETLoader', errors, seen);
  const clip = oneApiNode(graph, 'CLIPLoader', errors, seen);
  const vaes = apiNodesByClass(graph, 'VAELoader');
  if (vaes.length !== 2) {
    addIssue(
      errors,
      seen,
      'NODE_CLASS_MISSING',
      'The API graph must contain one video and one audio VAELoader.',
    );
  }
  const vaeNames = vaes.map((node) =>
    literalInput(node, 'vae_name', errors, seen),
  );
  const videoVae = vaeNames.find(
    (value) => value === MINIMAX_H3_MODEL_FILES.videoVae,
  );
  const audioVae = vaeNames.find(
    (value) => value === MINIMAX_H3_MODEL_FILES.audioVae,
  );
  if (!videoVae || !audioVae) {
    addIssue(
      errors,
      seen,
      'MODEL_MISSING',
      'The API graph must select the pinned video and audio VAE files.',
    );
  }
  const firstFrame = h3?.inputs.first_frame;
  const lastFrame = h3?.inputs.last_frame;
  if (firstFrame !== undefined || lastFrame !== undefined) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The T2VA preview profile does not accept first-frame or last-frame inputs.',
    );
  }
  return {
    prompt: literalInput(h3, 'prompt', errors, seen),
    width: literalInput(h3, 'width', errors, seen),
    height: literalInput(h3, 'height', errors, seen),
    frames: literalInput(h3, 'length', errors, seen),
    seed: literalInput(noise, 'noise_seed', errors, seen),
    steps: literalInput(scheduler, 'steps', errors, seen),
    fps: literalInput(createVideo, 'fps', errors, seen),
    turbo: false,
    diffusionModel: literalInput(unet, 'unet_name', errors, seen),
    textEncoder: literalInput(clip, 'clip_name', errors, seen),
    videoVae,
    audioVae,
    outputPrefix: literalInput(output, 'filename_prefix', errors, seen),
  };
}

function connection(
  node: ApiNode | undefined,
  input: string,
): readonly [string, number] | undefined {
  const value = node?.inputs[input];
  return isConnection(value) ? value : undefined;
}

function requireConnection(
  node: ApiNode | undefined,
  input: string,
  source: ApiNode | undefined,
  sourceSlot: number,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): void {
  const value = connection(node, input);
  if (!value || !source || value[0] !== source.id || value[1] !== sourceSlot) {
    addIssue(
      errors,
      seen,
      'OUTPUT_CONTRACT_INVALID',
      `The H3 API graph has invalid ${input} wiring.`,
    );
  }
}

function validateWiring(
  graph: ApiGraph,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): void {
  const h3 = oneApiNode(graph, 'MiniMaxH3ImageToVideo', errors, seen);
  const noise = oneApiNode(graph, 'RandomNoise', errors, seen);
  const scheduler = oneApiNode(graph, 'BasicScheduler', errors, seen);
  const samplerSelect = oneApiNode(graph, 'KSamplerSelect', errors, seen);
  const guider = oneApiNode(graph, 'BasicGuider', errors, seen);
  const sampler = oneApiNode(graph, 'SamplerCustomAdvanced', errors, seen);
  const decodeVideo = oneApiNode(graph, 'VAEDecode', errors, seen);
  const decodeAudio = oneApiNode(graph, 'VAEDecodeAudio', errors, seen);
  const createVideo = oneApiNode(graph, 'CreateVideo', errors, seen);
  const output = oneApiNode(graph, 'SaveVideo', errors, seen);
  const unet = oneApiNode(graph, 'UNETLoader', errors, seen);
  const clip = oneApiNode(graph, 'CLIPLoader', errors, seen);
  const vaes = apiNodesByClass(graph, 'VAELoader');
  const videoVae = vaes.find(
    (node) => node.inputs.vae_name === MINIMAX_H3_MODEL_FILES.videoVae,
  );
  const audioVae = vaes.find(
    (node) => node.inputs.vae_name === MINIMAX_H3_MODEL_FILES.audioVae,
  );

  requireConnection(sampler, 'noise', noise, 0, errors, seen);
  requireConnection(sampler, 'guider', guider, 0, errors, seen);
  requireConnection(sampler, 'sampler', samplerSelect, 0, errors, seen);
  requireConnection(sampler, 'sigmas', scheduler, 0, errors, seen);
  requireConnection(sampler, 'latent_image', h3, 1, errors, seen);
  requireConnection(guider, 'conditioning', h3, 0, errors, seen);
  requireConnection(guider, 'model', unet, 0, errors, seen);
  requireConnection(scheduler, 'model', unet, 0, errors, seen);
  requireConnection(h3, 'clip', clip, 0, errors, seen);
  requireConnection(h3, 'vae', videoVae, 0, errors, seen);
  requireConnection(decodeVideo, 'samples', sampler, 0, errors, seen);
  requireConnection(decodeAudio, 'samples', sampler, 0, errors, seen);
  requireConnection(decodeVideo, 'vae', videoVae, 0, errors, seen);
  requireConnection(decodeAudio, 'vae', audioVae, 0, errors, seen);
  requireConnection(createVideo, 'images', decodeVideo, 0, errors, seen);
  requireConnection(createVideo, 'audio', decodeAudio, 0, errors, seen);
  requireConnection(output, 'video', createVideo, 0, errors, seen);

  if (apiNodesByClass(graph, 'LoraLoaderModelOnly').length > 0) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The preview profile must export the non-turbo branch without a LoRA node.',
    );
  }
}

function durationToFrames(durationSeconds: number): number | undefined {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MINIMAX_H3_MAX_DURATION_SECONDS
  ) {
    return undefined;
  }
  const frames =
    17 * Math.ceil((durationSeconds * MINIMAX_H3_FPS - 5) / 17) + 5;
  return frames >= 5 && (frames - 5) % 17 === 0 ? frames : undefined;
}

export function minimaxH3DurationToFrames(durationSeconds: number): number {
  const frames = durationToFrames(durationSeconds);
  if (frames === undefined) {
    throw new Error(
      `Duration must be greater than zero and no greater than ${MINIMAX_H3_MAX_DURATION_SECONDS} seconds.`,
    );
  }
  return frames;
}

function validDimensions(width: unknown, height: unknown): boolean {
  if (
    !safeInteger(width) ||
    !safeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }
  if (width % 32 !== 0 || height % 32 !== 0) return false;
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  return (
    shortEdge <= MINIMAX_H3_MAX_SHORT_EDGE &&
    longEdge <= MINIMAX_H3_MAX_LONG_EDGE &&
    width * height <= MINIMAX_H3_MAX_SHORT_EDGE * MINIMAX_H3_MAX_LONG_EDGE
  );
}

function validFrameGrid(frames: unknown): frames is number {
  return safeInteger(frames) && frames >= 5 && (frames - 5) % 17 === 0;
}

function validOutputPrefix(value: unknown): value is string {
  if (!safeString(value, MAX_OUTPUT_PREFIX_LENGTH)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes('\\') || value.split('/').some((part) => part === '..')) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function compareField(
  field: string,
  editor: unknown,
  api: unknown,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): void {
  if (editor === undefined || api === undefined) return;
  if (!sameJson(editor, api)) {
    addIssue(
      errors,
      seen,
      'GRAPH_EXPORT_MISMATCH',
      `Editor and API graph values differ for ${field}.`,
    );
  }
}

function validateProfileParameters(
  editor: EditorValues,
  api: ApiValues,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): MinimaxH3EffectiveParameters | undefined {
  if (
    !safeString(editor.prompt, MAX_PROMPT_LENGTH) ||
    !safeString(api.prompt, MAX_PROMPT_LENGTH)
  ) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The H3 prompt must be a bounded literal string.',
    );
  }
  if (!validDimensions(editor.width, editor.height)) {
    addIssue(
      errors,
      seen,
      'DIMENSION_INVALID',
      'Editor H3 dimensions must be positive multiples of 32 within the native canvas cap.',
    );
  }
  if (!validDimensions(api.width, api.height)) {
    addIssue(
      errors,
      seen,
      'DIMENSION_INVALID',
      'H3 dimensions must be positive multiples of 32 within the native canvas cap.',
    );
  }
  if (!safeInteger(api.frames) || !validFrameGrid(api.frames)) {
    addIssue(
      errors,
      seen,
      'DURATION_GRID_INVALID',
      'H3 frame length must satisfy frames = 17n + 5.',
    );
  }
  if (api.fps !== MINIMAX_H3_FPS) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'H3 output frame rate must be exactly 24 fps.',
    );
  }
  if (editor.fps !== MINIMAX_H3_FPS) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'Editor H3 output frame rate must be exactly 24 fps.',
    );
  }
  if (
    api.steps !== MINIMAX_H3_DEFAULT_STEPS ||
    editor.steps !== MINIMAX_H3_DEFAULT_STEPS
  ) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The preview profile requires 20 non-turbo steps.',
    );
  }
  if (api.turbo !== false || editor.turbo !== false) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'Turbo execution is not selectable for the preview profile.',
    );
  }
  if (!safeInteger(api.seed) || api.seed < 0) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The H3 seed must be a non-negative safe JSON integer.',
    );
  }
  if (!safeInteger(editor.seed) || editor.seed < 0) {
    addIssue(
      errors,
      seen,
      'PARAMETER_MISMATCH',
      'The editor H3 seed must be a non-negative safe JSON integer.',
    );
  }
  const expectedFrames = safeFiniteNumber(editor.durationSeconds)
    ? durationToFrames(editor.durationSeconds)
    : editor.frames;
  if (expectedFrames === undefined || !validFrameGrid(expectedFrames)) {
    addIssue(
      errors,
      seen,
      'DURATION_GRID_INVALID',
      'The editor duration does not resolve to the H3 17n+5 frame grid.',
    );
  }
  if (expectedFrames !== undefined && api.frames !== undefined) {
    compareField('frame length', expectedFrames, api.frames, errors, seen);
  }

  compareField('prompt', editor.prompt, api.prompt, errors, seen);
  compareField('width', editor.width, api.width, errors, seen);
  compareField('height', editor.height, api.height, errors, seen);
  compareField('seed', editor.seed, api.seed, errors, seen);
  compareField('steps', editor.steps, api.steps, errors, seen);
  compareField('fps', editor.fps, api.fps, errors, seen);
  compareField(
    'diffusion model',
    editor.diffusionModel,
    api.diffusionModel,
    errors,
    seen,
  );
  compareField(
    'text encoder',
    editor.textEncoder,
    api.textEncoder,
    errors,
    seen,
  );
  compareField('video VAE', editor.videoVae, api.videoVae, errors, seen);
  compareField('audio VAE', editor.audioVae, api.audioVae, errors, seen);
  compareField(
    'output prefix',
    editor.outputPrefix,
    api.outputPrefix,
    errors,
    seen,
  );

  for (const [name, editorValue, apiValue, expected] of [
    [
      'diffusion model',
      editor.diffusionModel,
      api.diffusionModel,
      MINIMAX_H3_MODEL_FILES.diffusionModel,
    ],
    [
      'text encoder',
      editor.textEncoder,
      api.textEncoder,
      MINIMAX_H3_MODEL_FILES.textEncoder,
    ],
    [
      'video VAE',
      editor.videoVae,
      api.videoVae,
      MINIMAX_H3_MODEL_FILES.videoVae,
    ],
    [
      'audio VAE',
      editor.audioVae,
      api.audioVae,
      MINIMAX_H3_MODEL_FILES.audioVae,
    ],
  ] as const) {
    if (editorValue !== expected) {
      addIssue(
        errors,
        seen,
        'MODEL_MISSING',
        `The editor graph does not select the pinned ${name} file.`,
      );
    }
    if (apiValue !== expected) {
      addIssue(
        errors,
        seen,
        'MODEL_MISSING',
        `The API graph does not select the pinned ${name} file.`,
      );
    }
  }
  if (!validOutputPrefix(editor.outputPrefix)) {
    addIssue(
      errors,
      seen,
      'OUTPUT_CONTRACT_INVALID',
      'The editor SaveVideo filename prefix is not a safe relative prefix.',
    );
  }
  if (!validOutputPrefix(api.outputPrefix)) {
    addIssue(
      errors,
      seen,
      'OUTPUT_CONTRACT_INVALID',
      'The SaveVideo filename prefix is not a safe relative prefix.',
    );
  }

  const apiPrompt = api.prompt;
  const apiWidth = api.width;
  const apiHeight = api.height;
  const apiFrames = api.frames;
  const apiSeed = api.seed;
  const apiFps = api.fps;
  const apiSteps = api.steps;
  const apiOutputPrefix = api.outputPrefix;
  const apiDiffusionModel = api.diffusionModel;
  const apiTextEncoder = api.textEncoder;
  const apiVideoVae = api.videoVae;
  const apiAudioVae = api.audioVae;
  const editorDurationSeconds = editor.durationSeconds;
  if (
    !safeString(apiPrompt, MAX_PROMPT_LENGTH) ||
    !validDimensions(apiWidth, apiHeight) ||
    !validFrameGrid(apiFrames) ||
    !safeInteger(apiSeed) ||
    apiSeed < 0 ||
    apiFps !== MINIMAX_H3_FPS ||
    apiSteps !== MINIMAX_H3_DEFAULT_STEPS ||
    api.turbo !== false ||
    !validOutputPrefix(apiOutputPrefix) ||
    apiDiffusionModel !== MINIMAX_H3_MODEL_FILES.diffusionModel ||
    apiTextEncoder !== MINIMAX_H3_MODEL_FILES.textEncoder ||
    apiVideoVae !== MINIMAX_H3_MODEL_FILES.videoVae ||
    apiAudioVae !== MINIMAX_H3_MODEL_FILES.audioVae ||
    !safeFiniteNumber(editorDurationSeconds) ||
    expectedFrames === undefined
  ) {
    return undefined;
  }
  const requestedDurationSeconds = editorDurationSeconds;
  const width = apiWidth as number;
  const height = apiHeight as number;
  return {
    prompt: apiPrompt,
    width,
    height,
    requestedDurationSeconds,
    frames: apiFrames,
    actualDurationSeconds: apiFrames / MINIMAX_H3_FPS,
    seed: apiSeed,
    steps: apiSteps,
    fps: apiFps,
    turbo: false,
    nativeAudio: true,
    diffusionModel: apiDiffusionModel,
    textEncoder: apiTextEncoder,
    videoVae: apiVideoVae,
    audioVae: apiAudioVae,
    outputPrefix: apiOutputPrefix,
  };
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value))
    return value.some((item) => containsExactString(item, expected));
  if (isPlainRecord(value)) {
    return Object.values(value).some((item) =>
      containsExactString(item, expected),
    );
  }
  return false;
}

function executorClassMap(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (isPlainRecord(value.nodes)) return value.nodes;
  return value;
}

function modelNames(value: unknown): readonly string[] {
  const names = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.endsWith('.safetensors')) {
      names.add(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (isPlainRecord(candidate)) {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return [...names].sort();
}

export function minimaxH3ExecutorFingerprint(objectInfo: unknown): string {
  const classes = executorClassMap(objectInfo);
  if (!classes) throw new Error('Executor object info must be a JSON object.');
  const shape = {
    classes: Object.keys(classes)
      .filter((classType) =>
        MINIMAX_H3_REQUIRED_API_NODE_CLASSES.includes(classType as never),
      )
      .sort(),
    modelChoices: Object.fromEntries(
      ['UNETLoader', 'CLIPLoader', 'VAELoader'].map((classType) => [
        classType,
        modelNames(classes[classType]),
      ]),
    ),
  };
  return createHash('sha256')
    .update(canonicalizeJson(shape), 'utf8')
    .digest('hex');
}

function validateExecutor(
  objectInfo: unknown,
  errors: WorkflowValidationIssue[],
  seen: Set<string>,
): string | undefined {
  const classes = executorClassMap(objectInfo);
  if (!classes) {
    addIssue(
      errors,
      seen,
      'EXECUTOR_UNAVAILABLE',
      'Executor capability information is unavailable.',
    );
    return undefined;
  }
  let drifted = false;
  for (const classType of MINIMAX_H3_REQUIRED_API_NODE_CLASSES) {
    if (!Object.hasOwn(classes, classType)) {
      drifted = true;
      addIssue(
        errors,
        seen,
        'NODE_CLASS_MISSING',
        `Executor is missing required node class ${classType}.`,
      );
    }
  }
  const checks: readonly [string, string, string][] = [
    ['UNETLoader', 'diffusion model', MINIMAX_H3_MODEL_FILES.diffusionModel],
    ['CLIPLoader', 'text encoder', MINIMAX_H3_MODEL_FILES.textEncoder],
    ['VAELoader', 'video VAE', MINIMAX_H3_MODEL_FILES.videoVae],
    ['VAELoader', 'audio VAE', MINIMAX_H3_MODEL_FILES.audioVae],
  ];
  for (const [classType, label, model] of checks) {
    if (!Object.hasOwn(classes, classType)) continue;
    if (!containsExactString(classes[classType], model)) {
      drifted = true;
      addIssue(
        errors,
        seen,
        'MODEL_MISSING',
        `Executor ${classType} does not expose the pinned ${label} file.`,
      );
    }
  }
  if (drifted) {
    addIssue(
      errors,
      seen,
      'CAPABILITY_DRIFT',
      'Executor capabilities no longer satisfy the pinned MiniMax H3 profile.',
    );
  }
  return minimaxH3ExecutorFingerprint(objectInfo);
}

export function normalizeAttemptOutputPrefix(attemptId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(attemptId)) {
    throw new Error('Attempt identifier cannot be used in an output prefix.');
  }
  return `videoops/attempt-${attemptId}`;
}

export const MINIMAX_H3_EXECUTOR_OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [[MINIMAX_H3_MODEL_FILES.diffusionModel]],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [[MINIMAX_H3_MODEL_FILES.textEncoder]],
      },
    },
  },
  VAELoader: {
    input: {
      required: {
        vae_name: [
          [MINIMAX_H3_MODEL_FILES.videoVae, MINIMAX_H3_MODEL_FILES.audioVae],
        ],
      },
    },
  },
  MiniMaxH3ImageToVideo: {},
  RandomNoise: {},
  BasicScheduler: {},
  KSamplerSelect: {},
  BasicGuider: {},
  SamplerCustomAdvanced: {},
  VAEDecode: {},
  VAEDecodeAudio: {},
  CreateVideo: {},
  SaveVideo: {},
} as const;

export interface MinimaxH3FixtureSet {
  readonly editorGraph: Readonly<Record<string, unknown>>;
  readonly apiGraph: Readonly<Record<string, unknown>>;
  readonly manifest: MinimaxH3CompatibilityManifest;
}

/** Load the pinned editor/API golden fixtures kept outside the TS package. */
export async function loadMinimaxH3Fixtures(): Promise<MinimaxH3FixtureSet> {
  const fixtureDirectory = new URL(
    '../../../workflows/minimax-h3/',
    import.meta.url,
  );
  const [editorText, apiText, manifestText] = await Promise.all([
    readFile(fileURLToPath(new URL('editor.json', fixtureDirectory)), 'utf8'),
    readFile(fileURLToPath(new URL('api.json', fixtureDirectory)), 'utf8'),
    readFile(
      fileURLToPath(new URL('compatibility-manifest.json', fixtureDirectory)),
      'utf8',
    ),
  ]);
  const editorGraph = JSON.parse(editorText) as Readonly<
    Record<string, unknown>
  >;
  const apiGraph = JSON.parse(apiText) as Readonly<Record<string, unknown>>;
  const manifest = JSON.parse(manifestText) as MinimaxH3CompatibilityManifest;
  return { editorGraph, apiGraph, manifest };
}

export function validateMinimaxH3T2vaPreview(
  input: MinimaxH3ValidationInput,
): MinimaxH3ValidationResult {
  const errors: WorkflowValidationIssue[] = [];
  const seen = new Set<string>();
  if (
    (input.profileId !== undefined &&
      input.profileId !== MINIMAX_H3_PROFILE_ID) ||
    (input.profileVersion !== undefined &&
      input.profileVersion !== MINIMAX_H3_PROFILE_VERSION)
  ) {
    addIssue(
      errors,
      seen,
      'PROFILE_UNSUPPORTED',
      'The requested workflow profile is not the pinned MiniMax H3 preview profile.',
    );
  }
  const graphs = parseGraphs(input, errors, seen);
  if (graphs.editor) {
    validateEditorNodeClasses(graphs.editor, errors, seen);
  }
  const editor = graphs.editor ? editorValues(graphs.editor, errors, seen) : {};
  const api = graphs.api ? apiValues(graphs.api, errors, seen) : {};
  if (graphs.api) validateWiring(graphs.api, errors, seen);
  const effectiveParameters = validateProfileParameters(
    editor,
    api,
    errors,
    seen,
  );
  let executorFingerprint: string | undefined;
  if (input.objectInfo !== undefined) {
    executorFingerprint = validateExecutor(input.objectInfo, errors, seen);
  } else if (input.requireExecutor) {
    addIssue(
      errors,
      seen,
      'EXECUTOR_UNAVAILABLE',
      'Executor capability information is unavailable.',
    );
  }
  const executionParameters: Readonly<Record<string, unknown>> =
    effectiveParameters
      ? {
          width: effectiveParameters.width,
          height: effectiveParameters.height,
          frames: effectiveParameters.frames,
          requestedDurationSeconds:
            effectiveParameters.requestedDurationSeconds,
          actualDurationSeconds: effectiveParameters.actualDurationSeconds,
          fps: effectiveParameters.fps,
          seed: effectiveParameters.seed,
          steps: effectiveParameters.steps,
          turbo: false,
          nativeAudio: true,
          audioSampleRate: 32000,
          audioChannels: 2,
          diffusionModel: effectiveParameters.diffusionModel,
          textEncoder: effectiveParameters.textEncoder,
          videoVae: effectiveParameters.videoVae,
          audioVae: effectiveParameters.audioVae,
          outputPrefixPolicy:
            MINIMAX_H3_COMPATIBILITY_MANIFEST.outputPrefixPolicy,
        }
      : {};
  return {
    valid: errors.length === 0,
    profileId: MINIMAX_H3_PROFILE_ID,
    profileVersion: MINIMAX_H3_PROFILE_VERSION,
    errors,
    executionParameters,
    ...(effectiveParameters ? { effectiveParameters } : {}),
    ...(executorFingerprint ? { executorFingerprint } : {}),
  };
}
