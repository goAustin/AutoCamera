import { z } from 'zod';

const nodeEnvironments = ['development', 'test', 'production'] as const;
const comfyModes = ['fake', 'remote'] as const;
const logLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInteger = z.coerce.number().int().positive();
const requestTimeoutMs = z.coerce.number().int().min(100).max(120_000);
const optionalUrl = z.preprocess(
  (value: unknown) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

export const environmentSchema = z.object({
  NODE_ENV: z.enum(nodeEnvironments).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  API_PORT: port.default(3000),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'must be a PostgreSQL connection URL',
    )
    .default('postgres://h3_videoops:h3_videoops@127.0.0.1:5432/h3_videoops'),
  DEV_AUTH_TOKEN: z.preprocess(
    (value: unknown) => (value === undefined ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  ARTIFACT_ROOT: z.string().trim().min(1).default('.data/artifacts'),
  COMFY_MODE: z.enum(comfyModes).default('fake'),
  COMFY_BASE_URL: z.string().url().default('http://127.0.0.1:8188'),
  COMFY_WS_URL: z.string().url().default('ws://127.0.0.1:8188/ws'),
  COMFY_FRONTEND_URL: z.string().url().default('http://127.0.0.1:8188'),
  COMFY_AUTH_TOKEN: z.preprocess(
    (value: unknown) => (value === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  COMFY_REQUEST_TIMEOUT_MS: requestTimeoutMs.default(15_000),
  COMFY_CLIENT_ID_PREFIX: z.string().trim().min(1).default('h3-dev'),
  GPU_WORKER_ID: z.string().trim().min(1).default('local-worker-1'),
  PI_PROVIDER: z.string().trim().min(1).default('faux'),
  PI_MODEL: z.string().trim().min(1).default('h3-videoops-storyboard-v1'),
  PI_MAX_CONCURRENT_RUNS: positiveInteger.default(1),
  PI_API_KEY: z.preprocess(
    (value: unknown) => (value === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  PI_BASE_URL: optionalUrl,
  ATTEMPT_LEASE_SECONDS: positiveInteger.default(60),
  ATTEMPT_TIMEOUT_SECONDS: positiveInteger.default(300),
  PROJECT_DEFAULT_BUDGET_USD: z
    .string()
    .trim()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, 'must be a decimal USD amount')
    .refine((value) => Number(value) > 0, 'must be greater than zero')
    .default('25.00'),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  FAKE_COMFY_HOST: z.string().trim().min(1).default('127.0.0.1'),
  FAKE_COMFY_PORT: port.default(8188),
  WEB_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WEB_PORT: port.default(5173),
  POSTGRES_PORT: port.default(5432),
  VITE_API_ORIGIN: optionalUrl,
});

export type Environment = z.infer<typeof environmentSchema>;
export type NodeEnvironment = (typeof nodeEnvironments)[number];
export type ComfyMode = (typeof comfyModes)[number];
export type LogLevel = (typeof logLevels)[number];

export class ConfigurationError extends Error {
  readonly variableNames: readonly string[];

  constructor(variableNames: readonly string[]) {
    const uniqueNames = [...new Set(variableNames)];
    super(
      `Invalid or missing environment variables: ${uniqueNames.join(', ')}`,
    );
    this.name = 'ConfigurationError';
    this.variableNames = uniqueNames;
  }
}

export function parseEnvironment(raw: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(raw);

  if (!result.success) {
    const variableNames = result.error.issues.map((issue) => {
      const [name] = issue.path;
      return typeof name === 'string' ? name : 'environment';
    });
    throw new ConfigurationError(variableNames);
  }

  if (result.data.NODE_ENV !== 'test' && !result.data.DEV_AUTH_TOKEN) {
    throw new ConfigurationError(['DEV_AUTH_TOKEN']);
  }

  if (result.data.PI_PROVIDER !== 'faux' && !result.data.PI_API_KEY) {
    throw new ConfigurationError(['PI_API_KEY']);
  }

  const invalidComfyVariables = new Set<string>();
  const urlProtocols: ReadonlyArray<
    readonly [
      'COMFY_BASE_URL' | 'COMFY_WS_URL' | 'COMFY_FRONTEND_URL',
      readonly string[],
    ]
  > = [
    ['COMFY_BASE_URL', ['http:', 'https:']],
    ['COMFY_WS_URL', ['ws:', 'wss:']],
    ['COMFY_FRONTEND_URL', ['http:', 'https:']],
  ];
  for (const [name, allowedProtocols] of urlProtocols) {
    const value = result.data[name];
    const parsed = new URL(value);
    if (
      !allowedProtocols.includes(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      invalidComfyVariables.add(name);
    }
  }

  if (result.data.COMFY_MODE === 'remote') {
    for (const name of [
      'COMFY_BASE_URL',
      'COMFY_WS_URL',
      'COMFY_FRONTEND_URL',
    ] as const) {
      const rawValue = raw[name];
      if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
        invalidComfyVariables.add(name);
      }
    }
  }

  if (invalidComfyVariables.size > 0) {
    throw new ConfigurationError([...invalidComfyVariables]);
  }

  return result.data;
}

export interface ApiConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly webOrigin: string;
  readonly databaseUrl: string;
  readonly devAuthToken: string;
  readonly artifactRoot: string;
  readonly comfyMode: ComfyMode;
  readonly comfyBaseUrl: string;
  readonly comfyWsUrl: string;
  readonly comfyFrontendUrl: string;
  readonly comfyRequestTimeoutMs: number;
  readonly comfyClientIdPrefix: string;
  readonly comfyAuthToken?: string;
  readonly gpuWorkerId: string;
  readonly piProvider: string;
  readonly piModel: string;
  readonly piMaxConcurrentRuns: number;
  readonly piApiKey?: string;
  readonly piBaseUrl?: string;
  readonly attemptLeaseSeconds: number;
  readonly attemptTimeoutSeconds: number;
  readonly projectDefaultBudgetUsd: string;
  readonly otelExporterOtlpEndpoint?: string;
}

export function getApiConfig(raw: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = parseEnvironment(raw);
  const config: ApiConfig = {
    nodeEnv: environment.NODE_ENV,
    logLevel: environment.LOG_LEVEL,
    apiHost: environment.API_HOST,
    apiPort: environment.API_PORT,
    webOrigin: environment.WEB_ORIGIN,
    databaseUrl: environment.DATABASE_URL,
    devAuthToken:
      environment.DEV_AUTH_TOKEN ??
      (environment.NODE_ENV === 'test' ? 'test-token' : ''),
    artifactRoot: environment.ARTIFACT_ROOT,
    comfyMode: environment.COMFY_MODE,
    comfyBaseUrl: environment.COMFY_BASE_URL,
    comfyWsUrl: environment.COMFY_WS_URL,
    comfyFrontendUrl: environment.COMFY_FRONTEND_URL,
    comfyRequestTimeoutMs: environment.COMFY_REQUEST_TIMEOUT_MS,
    comfyClientIdPrefix: environment.COMFY_CLIENT_ID_PREFIX,
    gpuWorkerId: environment.GPU_WORKER_ID,
    piProvider: environment.PI_PROVIDER,
    piModel: environment.PI_MODEL,
    piMaxConcurrentRuns: environment.PI_MAX_CONCURRENT_RUNS,
    attemptLeaseSeconds: environment.ATTEMPT_LEASE_SECONDS,
    attemptTimeoutSeconds: environment.ATTEMPT_TIMEOUT_SECONDS,
    projectDefaultBudgetUsd: environment.PROJECT_DEFAULT_BUDGET_USD,
  };

  if (
    environment.COMFY_AUTH_TOKEN ||
    environment.PI_API_KEY ||
    environment.PI_BASE_URL ||
    environment.OTEL_EXPORTER_OTLP_ENDPOINT
  ) {
    return {
      ...config,
      ...(environment.COMFY_AUTH_TOKEN
        ? { comfyAuthToken: environment.COMFY_AUTH_TOKEN }
        : {}),
      ...(environment.PI_API_KEY ? { piApiKey: environment.PI_API_KEY } : {}),
      ...(environment.PI_BASE_URL
        ? { piBaseUrl: environment.PI_BASE_URL }
        : {}),
      ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT
        ? { otelExporterOtlpEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }
        : {}),
    };
  }

  return config;
}

export interface FakeComfyConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly host: string;
  readonly port: number;
  readonly authToken?: string;
}

export function getFakeComfyConfig(
  raw: NodeJS.ProcessEnv = process.env,
): FakeComfyConfig {
  const environment = parseEnvironment(raw);
  return {
    nodeEnv: environment.NODE_ENV,
    logLevel: environment.LOG_LEVEL,
    host: environment.FAKE_COMFY_HOST,
    port: environment.FAKE_COMFY_PORT,
    ...(environment.COMFY_AUTH_TOKEN
      ? { authToken: environment.COMFY_AUTH_TOKEN }
      : {}),
  };
}

export interface WebConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly apiOrigin: string;
}

export function getWebConfig(raw: NodeJS.ProcessEnv = process.env): WebConfig {
  const environment = parseEnvironment(raw);
  return {
    nodeEnv: environment.NODE_ENV,
    host: environment.WEB_HOST,
    port: environment.WEB_PORT,
    apiOrigin:
      environment.VITE_API_ORIGIN ??
      `http://${environment.API_HOST}:${environment.API_PORT}`,
  };
}
