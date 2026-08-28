import { z } from 'zod';

const nodeEnvironments = ['development', 'test', 'production'] as const;
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
  COMFY_BASE_URL: z.string().url().default('http://127.0.0.1:8188'),
  COMFY_WS_URL: z.string().url().default('ws://127.0.0.1:8188/ws'),
  COMFY_CLIENT_ID_PREFIX: z.string().trim().min(1).default('h3-dev'),
  GPU_WORKER_ID: z.string().trim().min(1).default('local-worker-1'),
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
  readonly comfyBaseUrl: string;
  readonly comfyWsUrl: string;
  readonly comfyClientIdPrefix: string;
  readonly gpuWorkerId: string;
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
    comfyBaseUrl: environment.COMFY_BASE_URL,
    comfyWsUrl: environment.COMFY_WS_URL,
    comfyClientIdPrefix: environment.COMFY_CLIENT_ID_PREFIX,
    gpuWorkerId: environment.GPU_WORKER_ID,
    attemptLeaseSeconds: environment.ATTEMPT_LEASE_SECONDS,
    attemptTimeoutSeconds: environment.ATTEMPT_TIMEOUT_SECONDS,
    projectDefaultBudgetUsd: environment.PROJECT_DEFAULT_BUDGET_USD,
  };

  if (environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return {
      ...config,
      otelExporterOtlpEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT,
    };
  }

  return config;
}

export interface FakeComfyConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly host: string;
  readonly port: number;
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
