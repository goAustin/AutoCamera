import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;

interface PinManifest {
  readonly comfyui: {
    readonly repository: string;
    readonly ref: string;
  };
  readonly comfyuiFrontend: {
    readonly repository: string;
    readonly ref: string;
  };
  readonly workflowTemplates: {
    readonly repository: string;
    readonly ref: string;
    readonly h3T2vTemplate: string;
  };
  readonly models: Readonly<Record<string, string>>;
}

interface CompatibilityManifest {
  readonly requiredApiNodeClasses: readonly string[];
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinManifestPath = resolve(
  repositoryRoot,
  'infra/gpu-executor/pin-manifest.json',
);
const compatibilityManifestPath = resolve(
  repositoryRoot,
  'workflows/minimax-h3/compatibility-manifest.json',
);

const modelInputFiles: Readonly<Record<string, string>> = {
  unet_name: 'diffusionModel',
  clip_name: 'textEncoder',
  vae_name: 'vae',
  lora_name: 'turboLora',
};

const modelFileKeysByInput: Readonly<Record<string, readonly string[]>> = {
  unet_name: ['diffusionModel'],
  clip_name: ['textEncoder'],
  vae_name: ['videoVae', 'audioVae'],
  lora_name: ['turboLora'],
};

const frontendOnlyNodeTypes = new Set(['MarkdownNote', 'Note']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRepositoryPath(value: string): string {
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson<T>(path: string): Promise<T> {
  const bytes = await readFile(path);
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`Could not parse JSON at ${path}: ${detail}`);
  }
}

function objectInfoClasses(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new Error('The raw /object_info response must be a JSON object.');
  }
  if (isRecord(value.nodes)) return value.nodes;
  return value;
}

function comboOptions(value: unknown, options: readonly string[]): unknown {
  if (Array.isArray(value) && Array.isArray(value[0])) {
    return [options, ...value.slice(1)];
  }
  if (Array.isArray(value) && value.length === 0) return [options];
  return [options];
}

function injectModelFiles(
  classType: string,
  definition: unknown,
  modelFiles: Readonly<Record<string, string>>,
  injectedInputs: Set<string>,
): unknown {
  if (Array.isArray(definition)) {
    return definition.map((item) =>
      injectModelFiles(classType, item, modelFiles, injectedInputs),
    );
  }
  if (!isRecord(definition)) return definition;

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(definition)) {
    const fileKeys = modelFileKeysByInput[key];
    if (fileKeys) {
      const options = fileKeys.map((fileKey) => {
        const path = modelFiles[fileKey];
        if (typeof path !== 'string' || path.length === 0) {
          throw new Error(
            `pin-manifest.json is missing models.${fileKey}, needed for ${classType}.${key}.`,
          );
        }
        return basename(path);
      });
      result[key] = comboOptions(value, options);
      injectedInputs.add(`${classType}.${key}`);
      continue;
    }
    result[key] = injectModelFiles(
      classType,
      value,
      modelFiles,
      injectedInputs,
    );
  }
  return result;
}

function collectTemplateNodeTypes(
  value: unknown,
  result = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectTemplateNodeTypes(item, result);
    return result;
  }
  if (!isRecord(value)) return result;

  if (
    typeof value.type === 'string' &&
    ('inputs' in value || 'outputs' in value || 'widgets_values' in value)
  ) {
    result.add(value.type);
  }
  if (typeof value.class_type === 'string') result.add(value.class_type);
  for (const child of Object.values(value)) {
    collectTemplateNodeTypes(child, result);
  }
  return result;
}

function templateSubgraphIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(value) || !isRecord(value.definitions)) return ids;
  const subgraphs = value.definitions.subgraphs;
  if (!Array.isArray(subgraphs)) return ids;
  for (const subgraph of subgraphs) {
    if (isRecord(subgraph) && typeof subgraph.id === 'string') {
      ids.add(subgraph.id);
    }
  }
  return ids;
}

function parseArguments(): {
  readonly rawPath: string;
  readonly outputPath: string;
  readonly metaPath: string;
  readonly templatePath: string;
  readonly captureDate?: string;
} {
  const positional: string[] = [];
  let captureDate: string | undefined;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--capture-date=')) {
      captureDate = argument.slice('--capture-date='.length);
    } else if (argument.startsWith('--raw=')) {
      positional[0] = argument.slice('--raw='.length);
    } else if (argument.startsWith('--output=')) {
      positional[1] = argument.slice('--output='.length);
    } else if (argument.startsWith('--template=')) {
      positional[2] = argument.slice('--template='.length);
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  const rawPath = resolveRepositoryPath(
    positional[0] ||
      process.env.H3_OBJECT_INFO_RAW_PATH ||
      '.data/object-info.raw.json',
  );
  const outputPath = resolveRepositoryPath(
    positional[1] ||
      process.env.H3_OBJECT_INFO_FIXTURE_PATH ||
      'apps/fake-comfy/fixtures/object-info.pinned.json',
  );
  const metaPath = outputPath.replace(/\.json$/u, '.meta.json');
  const templatePath = resolveRepositoryPath(
    positional[2] ||
      process.env.H3_WORKFLOW_TEMPLATE_PATH ||
      '.data/workflow-templates/templates/video_minimax_h3_t2v.json',
  );
  return {
    rawPath,
    outputPath,
    metaPath,
    templatePath,
    ...(captureDate ? { captureDate } : {}),
  };
}

async function main(): Promise<void> {
  const paths = parseArguments();
  const [rawBytes, pinManifest, compatibilityManifest, templateBytes] =
    await Promise.all([
      readFile(paths.rawPath),
      readJson<PinManifest>(pinManifestPath),
      readJson<CompatibilityManifest>(compatibilityManifestPath),
      readFile(paths.templatePath),
    ]);

  const raw = JSON.parse(rawBytes.toString('utf8')) as unknown;
  const template = JSON.parse(templateBytes.toString('utf8')) as unknown;
  const rawClasses = objectInfoClasses(raw);
  const injectedInputs = new Set<string>();
  const fixture: JsonRecord = {};
  for (const [classType, definition] of Object.entries(rawClasses)) {
    fixture[classType] = injectModelFiles(
      classType,
      definition,
      pinManifest.models,
      injectedInputs,
    );
  }

  for (const [inputName, fileKey] of Object.entries(modelInputFiles)) {
    if (fileKey === 'vae') {
      if (![...injectedInputs].some((value) => value.endsWith('.vae_name'))) {
        throw new Error(
          `The raw capture has no vae_name combo input to inject ${inputName}.`,
        );
      }
      continue;
    }
    if (![...injectedInputs].some((value) => value.endsWith(`.${inputName}`))) {
      throw new Error(
        `The raw capture has no ${inputName} combo input for pin-manifest model ${fileKey}.`,
      );
    }
  }

  const templateTypes = collectTemplateNodeTypes(template);
  const allowedSubgraphIds = templateSubgraphIds(template);
  for (const classType of compatibilityManifest.requiredApiNodeClasses) {
    if (!Object.hasOwn(fixture, classType)) {
      throw new Error(
        `The raw capture is missing required API node class ${classType}.`,
      );
    }
  }
  const missingTemplateTypes = [...templateTypes]
    .filter(
      (classType) =>
        !Object.hasOwn(fixture, classType) &&
        !frontendOnlyNodeTypes.has(classType) &&
        !allowedSubgraphIds.has(classType),
    )
    .sort((left, right) => left.localeCompare(right));
  if (missingTemplateTypes.length > 0) {
    throw new Error(
      `Template references node classes missing from captured /object_info: ${missingTemplateTypes.join(', ')}`,
    );
  }

  const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
  const fixtureBytes = Buffer.from(fixtureText, 'utf8');
  let captureDate = paths.captureDate ?? process.env.H3_CAPTURE_DATE;
  if (!captureDate) {
    try {
      const previous = await readJson<{ readonly captureDate?: string }>(
        paths.metaPath,
      );
      captureDate = previous.captureDate;
    } catch {
      // A first capture uses today's UTC date. Repeated captures preserve it.
    }
  }
  captureDate ??= new Date().toISOString().slice(0, 10);

  const meta = {
    manifestVersion: 1,
    comfyuiCommit: pinManifest.comfyui.ref,
    comfyuiRepository: pinManifest.comfyui.repository,
    captureDate,
    rawCaptureSha256: sha256(rawBytes),
    fixtureSha256: sha256(fixtureBytes),
    templateRepository: pinManifest.workflowTemplates.repository,
    templateCommit: pinManifest.workflowTemplates.ref,
    templatePath: pinManifest.workflowTemplates.h3T2vTemplate,
    templateSha256: sha256(templateBytes),
    injectedModelFiles: Object.fromEntries(
      Object.entries(pinManifest.models).map(([key, path]) => [
        key,
        basename(path),
      ]),
    ),
    nodeCount: Object.keys(fixture).length,
  };

  await writeFile(paths.outputPath, fixtureBytes);
  await writeFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(
    `Captured ${Object.keys(fixture).length} node definitions into ${paths.outputPath}`,
  );
  console.log(`Raw capture sha256: ${meta.rawCaptureSha256}`);
  console.log(`Fixture sha256: ${meta.fixtureSha256}`);
  console.log(
    `Template classes verified: ${[...templateTypes].sort((a, b) => a.localeCompare(b)).join(', ')}`,
  );
}

await main();
