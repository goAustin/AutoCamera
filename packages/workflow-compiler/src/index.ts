import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson } from './canonical.js';

export {
  canonicalizeJson,
  canonicalizeWorkflowExecutionEnvelope,
  hashWorkflowExecutionEnvelope,
  jsonByteLength,
  WorkflowCanonicalizationError,
} from './canonical.js';

export const MVP_PREVIEW_WIDTH = 960;
export const MVP_PREVIEW_HEIGHT = 544;
export const MVP_PREVIEW_FPS = 24;
export const MVP_DURATION_MIN_SECONDS = 1;
export const MVP_DURATION_MAX_SECONDS = 10;

export interface WorkflowNode {
  readonly class_type: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export type FixtureWorkflow = Readonly<Record<string, WorkflowNode>>;

export type WorkflowSemanticBindingName =
  | 'prompt'
  | 'width'
  | 'height'
  | 'durationFrames'
  | 'seed'
  | 'steps';

export interface WorkflowManifestNode {
  readonly nodeId: string;
  readonly classType: string;
}

export interface WorkflowSemanticBinding {
  readonly name: WorkflowSemanticBindingName;
  readonly nodeId: string;
  readonly classType: string;
  readonly path: readonly string[];
}

export interface WorkflowManifest {
  readonly family: 'h3-t2v-fixture';
  readonly version: string;
  readonly requiredNodes: readonly WorkflowManifestNode[];
  readonly bindings: readonly WorkflowSemanticBinding[];
}

export interface WorkflowCompileInput {
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly seed: number;
  readonly steps: number;
}

export interface CompiledWorkflow {
  readonly family: WorkflowManifest['family'];
  readonly version: string;
  readonly workflowHash: string;
  readonly workflow: FixtureWorkflow;
  readonly manifest: WorkflowManifest;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly durationFrames: number;
  readonly seed: number;
  readonly steps: number;
}

export class WorkflowCompileError extends Error {
  readonly code:
    | 'INVALID_WORKFLOW'
    | 'MISSING_NODE'
    | 'MISMATCHED_NODE_CLASS'
    | 'MISSING_BINDING'
    | 'MISSING_BINDING_PATH'
    | 'INVALID_PREVIEW_DIMENSIONS'
    | 'INVALID_DURATION_GRID'
    | 'INVALID_PARAMETER';

  constructor(code: WorkflowCompileError['code'], message: string) {
    super(message);
    this.name = 'WorkflowCompileError';
    this.code = code;
  }
}

/**
 * The graph this project ships, verbatim: `workflows/minimax-h3/api.json`, the
 * one a pinned remote ComfyUI accepted on 2026-09-13. It is duplicated here
 * rather than read at import time so this module stays a pure constant, and
 * `index.test.ts` asserts the two are identical -- the same bargain
 * `packages/comfy-client` makes with the pinned capability fingerprint: one
 * visible decision when the pin moves, instead of two copies drifting.
 *
 * The four-node stand-in this replaced (CLIPTextEncode, EmptyHunyuanLatentVideo,
 * KSampler, SaveVideo, with most required inputs simply absent) predated the
 * fake executor enforcing `input.required` from the pinned catalogue. Once it
 * did, the offline path submitted a graph the real executor would reject, and
 * every non-managed attempt failed COMFY_UNAVAILABLE.
 */
export const FIXTURE_WORKFLOW: FixtureWorkflow = {
  '92': {
    class_type: 'SaveVideo',
    inputs: {
      video: ['130', 0],
      filename_prefix: 'video/MiniMax_H3',
      format: 'auto',
      codec: 'auto',
    },
    _meta: {
      title: 'SaveVideo',
    },
  },
  '119': {
    class_type: 'VAELoader',
    inputs: {
      vae_name: 'minimax_h3_video_vae_fp16.safetensors',
    },
    _meta: {
      title: 'VAELoader',
    },
  },
  '120': {
    class_type: 'VAELoader',
    inputs: {
      vae_name: 'minimax_h3_audio_vae_fp32.safetensors',
    },
    _meta: {
      title: 'VAELoader',
    },
  },
  '121': {
    class_type: 'VAEDecodeAudio',
    inputs: {
      samples: ['125', 0],
      vae: ['120', 0],
    },
    _meta: {
      title: 'VAEDecodeAudio',
    },
  },
  '122': {
    class_type: 'VAEDecode',
    inputs: {
      samples: ['125', 0],
      vae: ['119', 0],
    },
    _meta: {
      title: 'VAEDecode',
    },
  },
  '123': {
    class_type: 'KSamplerSelect',
    inputs: {
      sampler_name: 'res_multistep',
    },
    _meta: {
      title: 'KSamplerSelect',
    },
  },
  '124': {
    class_type: 'BasicScheduler',
    inputs: {
      model: ['127', 0],
      steps: 20,
      scheduler: 'simple',
      denoise: 1,
    },
    _meta: {
      title: 'BasicScheduler',
    },
  },
  '125': {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['129', 0],
      guider: ['126', 0],
      sampler: ['123', 0],
      sigmas: ['124', 0],
      latent_image: ['131', 1],
    },
    _meta: {
      title: 'SamplerCustomAdvanced',
    },
  },
  '126': {
    class_type: 'BasicGuider',
    inputs: {
      model: ['127', 0],
      conditioning: ['131', 0],
    },
    _meta: {
      title: 'BasicGuider',
    },
  },
  '127': {
    class_type: 'UNETLoader',
    inputs: {
      unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      weight_dtype: 'default',
    },
    _meta: {
      title: 'UNETLoader',
    },
  },
  '128': {
    class_type: 'CLIPLoader',
    inputs: {
      clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      type: 'minimax',
      device: 'default',
    },
    _meta: {
      title: 'CLIPLoader',
    },
  },
  '129': {
    class_type: 'RandomNoise',
    inputs: {
      noise_seed: 42,
    },
    _meta: {
      title: 'RandomNoise',
    },
  },
  '130': {
    class_type: 'CreateVideo',
    inputs: {
      images: ['122', 0],
      audio: ['121', 0],
      fps: 24,
      bit_depth: 8,
    },
    _meta: {
      title: 'CreateVideo',
    },
  },
  '131': {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['128', 0],
      vae: ['119', 0],
      prompt:
        'A polished product moves through a cool blue studio with natural stereo sound, smooth camera motion, and a confident premium finish.',
      width: 960,
      height: 544,
      length: 124,
    },
    _meta: {
      title: 'MiniMaxH3ImageToVideo',
    },
  },
};

/**
 * Bindings address the shipped graph's own nodes: generation parameters live on
 * `MiniMaxH3ImageToVideo` (131), the seed on `RandomNoise` (129), and step count
 * on `BasicScheduler` (124). `requiredNodes` names those three plus the output
 * node, which is what `validateManifest` refuses to compile without.
 */
export const FIXTURE_MANIFEST: WorkflowManifest = {
  family: 'h3-t2v-fixture',
  version: 'h3-t2v-fixture-v2',
  requiredNodes: [
    {
      nodeId: '124',
      classType: 'BasicScheduler',
    },
    {
      nodeId: '129',
      classType: 'RandomNoise',
    },
    {
      nodeId: '131',
      classType: 'MiniMaxH3ImageToVideo',
    },
    {
      nodeId: '92',
      classType: 'SaveVideo',
    },
  ],
  bindings: [
    {
      name: 'prompt',
      nodeId: '131',
      classType: 'MiniMaxH3ImageToVideo',
      path: ['inputs', 'prompt'],
    },
    {
      name: 'width',
      nodeId: '131',
      classType: 'MiniMaxH3ImageToVideo',
      path: ['inputs', 'width'],
    },
    {
      name: 'height',
      nodeId: '131',
      classType: 'MiniMaxH3ImageToVideo',
      path: ['inputs', 'height'],
    },
    {
      name: 'durationFrames',
      nodeId: '131',
      classType: 'MiniMaxH3ImageToVideo',
      path: ['inputs', 'length'],
    },
    {
      name: 'seed',
      nodeId: '129',
      classType: 'RandomNoise',
      path: ['inputs', 'noise_seed'],
    },
    {
      name: 'steps',
      nodeId: '124',
      classType: 'BasicScheduler',
      path: ['inputs', 'steps'],
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const semanticBindingNames = new Set<WorkflowSemanticBindingName>([
  'prompt',
  'width',
  'height',
  'durationFrames',
  'seed',
  'steps',
]);

function cloneWorkflow(
  workflow: FixtureWorkflow,
): Record<string, WorkflowNode> {
  const clone: Record<string, WorkflowNode> = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    clone[nodeId] = {
      ...node,
      inputs: { ...node.inputs },
      ...(node._meta ? { _meta: { ...node._meta } } : {}),
    };
  }
  return clone;
}

function setBinding(
  workflow: Record<string, WorkflowNode>,
  binding: WorkflowSemanticBinding,
  value: unknown,
): void {
  const node = workflow[binding.nodeId];
  if (!node) {
    throw new WorkflowCompileError(
      'MISSING_NODE',
      `Workflow binding node ${binding.nodeId} is missing.`,
    );
  }
  if (node.class_type !== binding.classType) {
    throw new WorkflowCompileError(
      'MISMATCHED_NODE_CLASS',
      `Workflow node ${binding.nodeId} has class ${node.class_type}, expected ${binding.classType}.`,
    );
  }
  if (
    !Array.isArray(binding.path) ||
    binding.path.length !== 2 ||
    binding.path[0] !== 'inputs'
  ) {
    throw new WorkflowCompileError(
      'MISSING_BINDING_PATH',
      `Binding ${binding.name} must target an input path.`,
    );
  }
  const containerKey = binding.path[0];
  const field = binding.path[1];
  if (!containerKey || !field || !Object.hasOwn(node, containerKey)) {
    throw new WorkflowCompileError(
      'MISSING_BINDING_PATH',
      `Binding ${binding.name} points to a missing path.`,
    );
  }
  const inputs = node.inputs as Record<string, unknown>;
  if (!Object.hasOwn(inputs, field)) {
    throw new WorkflowCompileError(
      'MISSING_BINDING_PATH',
      `Binding ${binding.name} points to a missing input.`,
    );
  }
  inputs[field] = value;
}

function validateManifest(
  workflow: FixtureWorkflow,
  manifest: WorkflowManifest,
): void {
  if (
    !isRecord(workflow) ||
    manifest.family !== 'h3-t2v-fixture' ||
    typeof manifest.version !== 'string' ||
    !manifest.version.trim() ||
    !Array.isArray(manifest.requiredNodes) ||
    !Array.isArray(manifest.bindings)
  ) {
    throw new WorkflowCompileError(
      'INVALID_WORKFLOW',
      'Only the h3-t2v-fixture manifest family is supported.',
    );
  }
  for (const node of Object.values(workflow)) {
    if (
      !isRecord(node) ||
      typeof node.class_type !== 'string' ||
      !node.class_type.trim() ||
      !isRecord(node.inputs)
    ) {
      throw new WorkflowCompileError(
        'INVALID_WORKFLOW',
        'Every workflow node must have a class type and input object.',
      );
    }
  }
  const bindingNames = new Set<string>();
  for (const requiredNode of manifest.requiredNodes) {
    if (
      !isRecord(requiredNode) ||
      typeof requiredNode.nodeId !== 'string' ||
      typeof requiredNode.classType !== 'string'
    ) {
      throw new WorkflowCompileError(
        'INVALID_WORKFLOW',
        'Required workflow node declarations are invalid.',
      );
    }
    const node = workflow[requiredNode.nodeId];
    if (!node) {
      throw new WorkflowCompileError(
        'MISSING_NODE',
        `Required workflow node ${requiredNode.nodeId} is missing.`,
      );
    }
    if (node.class_type !== requiredNode.classType) {
      throw new WorkflowCompileError(
        'MISMATCHED_NODE_CLASS',
        `Workflow node ${requiredNode.nodeId} has an unexpected class.`,
      );
    }
  }
  for (const binding of manifest.bindings) {
    if (
      !isRecord(binding) ||
      typeof binding.name !== 'string' ||
      typeof binding.nodeId !== 'string' ||
      typeof binding.classType !== 'string' ||
      !Array.isArray(binding.path)
    ) {
      throw new WorkflowCompileError(
        'MISSING_BINDING',
        'Workflow semantic binding declarations are invalid.',
      );
    }
    if (bindingNames.has(binding.name)) {
      throw new WorkflowCompileError(
        'INVALID_WORKFLOW',
        `Binding ${binding.name} is declared more than once.`,
      );
    }
    bindingNames.add(binding.name);
    if (
      !semanticBindingNames.has(binding.name as WorkflowSemanticBindingName)
    ) {
      throw new WorkflowCompileError(
        'INVALID_WORKFLOW',
        `Binding ${binding.name} is not a supported semantic parameter.`,
      );
    }
    if (!binding.nodeId || !binding.classType || binding.path.length === 0) {
      throw new WorkflowCompileError(
        'MISSING_BINDING',
        `Binding ${binding.name} is incomplete.`,
      );
    }
    const node = workflow[binding.nodeId];
    if (!node) {
      throw new WorkflowCompileError(
        'MISSING_NODE',
        `Binding node ${binding.nodeId} is missing.`,
      );
    }
    if (node.class_type !== binding.classType) {
      throw new WorkflowCompileError(
        'MISMATCHED_NODE_CLASS',
        `Binding node ${binding.nodeId} has an unexpected class.`,
      );
    }
    if (
      binding.path.length !== 2 ||
      binding.path[0] !== 'inputs' ||
      !isRecord(node.inputs) ||
      !Object.hasOwn(node.inputs, binding.path[1] ?? '')
    ) {
      throw new WorkflowCompileError(
        'MISSING_BINDING_PATH',
        `Binding ${binding.name} points to a missing input.`,
      );
    }
  }
  for (const name of [
    'prompt',
    'width',
    'height',
    'durationFrames',
    'seed',
    'steps',
  ]) {
    if (!bindingNames.has(name)) {
      throw new WorkflowCompileError(
        'MISSING_BINDING',
        `Required semantic binding ${name} is missing.`,
      );
    }
  }
}

function assertPreviewDimensions(width: number, height: number): void {
  if (
    width !== MVP_PREVIEW_WIDTH ||
    height !== MVP_PREVIEW_HEIGHT ||
    width % 32 !== 0 ||
    height % 32 !== 0
  ) {
    throw new WorkflowCompileError(
      'INVALID_PREVIEW_DIMENSIONS',
      `Preview dimensions must be exactly ${MVP_PREVIEW_WIDTH}x${MVP_PREVIEW_HEIGHT} and multiples of 32.`,
    );
  }
}

export function durationToFrames(durationSeconds: number): number {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < MVP_DURATION_MIN_SECONDS ||
    durationSeconds > MVP_DURATION_MAX_SECONDS
  ) {
    throw new WorkflowCompileError(
      'INVALID_DURATION_GRID',
      `Preview duration must be between ${MVP_DURATION_MIN_SECONDS} and ${MVP_DURATION_MAX_SECONDS} seconds.`,
    );
  }
  const frames = Math.round(durationSeconds * MVP_PREVIEW_FPS);
  if (
    frames < MVP_PREVIEW_FPS ||
    frames > MVP_DURATION_MAX_SECONDS * MVP_PREVIEW_FPS
  ) {
    throw new WorkflowCompileError(
      'INVALID_DURATION_GRID',
      'Preview duration must resolve to a positive 24 fps frame grid.',
    );
  }
  return frames;
}

export function compileWorkflow(
  input: WorkflowCompileInput,
  workflow: FixtureWorkflow = FIXTURE_WORKFLOW,
  manifest: WorkflowManifest = FIXTURE_MANIFEST,
): CompiledWorkflow {
  if (!input.prompt.trim() || !Number.isSafeInteger(input.seed)) {
    throw new WorkflowCompileError(
      'INVALID_PARAMETER',
      'Prompt and seed are required workflow parameters.',
    );
  }
  if (
    !Number.isSafeInteger(input.steps) ||
    input.steps <= 0 ||
    input.steps > 100
  ) {
    throw new WorkflowCompileError(
      'INVALID_PARAMETER',
      'Steps must be a positive safe integer no greater than 100.',
    );
  }
  const width = input.width ?? MVP_PREVIEW_WIDTH;
  const height = input.height ?? MVP_PREVIEW_HEIGHT;
  const durationSeconds = input.durationSeconds ?? 5;
  assertPreviewDimensions(width, height);
  const durationFrames = durationToFrames(durationSeconds);
  validateManifest(workflow, manifest);
  const compiled = cloneWorkflow(workflow);
  const values: Readonly<Record<WorkflowSemanticBindingName, unknown>> = {
    prompt: input.prompt,
    width,
    height,
    durationFrames,
    seed: input.seed,
    steps: input.steps,
  };
  for (const binding of manifest.bindings) {
    setBinding(compiled, binding, values[binding.name]);
  }
  const workflowHash = createHash('sha256')
    .update(canonicalizeJson(compiled), 'utf8')
    .digest('hex');
  return {
    family: manifest.family,
    version: manifest.version,
    workflowHash,
    workflow: compiled,
    manifest,
    width,
    height,
    durationSeconds: durationFrames / MVP_PREVIEW_FPS,
    durationFrames,
    seed: input.seed,
    steps: input.steps,
  };
}

export async function loadFixtureFiles(): Promise<{
  readonly workflow: FixtureWorkflow;
  readonly manifest: WorkflowManifest;
}> {
  // The graph is read from the one shipped copy -- the same file
  // `loadMinimaxH3Fixtures` reads -- rather than from a third copy beside this
  // module. `fixture-workflow.json` was that third copy; nothing but one test
  // ever loaded it, which is how it stayed four nodes long after the graph we
  // ship grew to fourteen.
  const workflowUrl = new URL(
    '../../../workflows/minimax-h3/api.json',
    import.meta.url,
  );
  const manifestUrl = new URL('./fixture-manifest.json', import.meta.url);
  try {
    const [workflowText, manifestText] = await Promise.all([
      readFile(fileURLToPath(workflowUrl), 'utf8'),
      readFile(fileURLToPath(manifestUrl), 'utf8'),
    ]);
    return {
      workflow: JSON.parse(workflowText) as FixtureWorkflow,
      manifest: JSON.parse(manifestText) as WorkflowManifest,
    };
  } catch {
    return { workflow: FIXTURE_WORKFLOW, manifest: FIXTURE_MANIFEST };
  }
}

export interface WorkflowVersionPersistence {
  findByHash(workflowHash: string): Promise<{
    readonly id: string;
    readonly version: string;
    readonly workflowHash: string;
    readonly workflowJson: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  } | null>;
  create(version: {
    readonly id: string;
    readonly version: string;
    readonly workflowHash: string;
    readonly workflowJson: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  }): Promise<void>;
}

export async function compileAndPersistWorkflow(
  input: WorkflowCompileInput,
  persistence: WorkflowVersionPersistence,
  options: {
    readonly id: string;
    readonly createdAt: string;
    readonly workflow?: FixtureWorkflow;
    readonly manifest?: WorkflowManifest;
  },
): Promise<CompiledWorkflow & { readonly workflowVersionId: string }> {
  const compiled = compileWorkflow(input, options.workflow, options.manifest);
  const existing = await persistence.findByHash(compiled.workflowHash);
  if (existing) {
    return { ...compiled, workflowVersionId: existing.id };
  }
  await persistence.create({
    id: options.id,
    version: compiled.version,
    workflowHash: compiled.workflowHash,
    workflowJson: compiled.workflow,
    createdAt: options.createdAt,
  });
  return { ...compiled, workflowVersionId: options.id };
}

export * from './minimax-h3.js';
