import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 100;

export type ComfyObjectInfoResponse = Readonly<Record<string, unknown>>;

export type ComfySystemStatsResponse = Readonly<Record<string, unknown>>;

export interface ComfyHealthResponse {
  readonly service: 'fake-comfy';
  readonly status: 'ok';
}

export type ComfyScenario =
  | 'success'
  | 'duplicate-events'
  | 'disconnect-reconcile'
  | 'execution-failure'
  | 'timeout'
  | 'uncertain-submission';

export interface ComfyCapabilities {
  readonly apiVersion: string;
  readonly supportsWebSocket: boolean;
  readonly supportsCancellation: boolean;
  readonly preservesExtraData: boolean;
  readonly capabilityFingerprint: string;
}

export interface ComfyReadiness {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly apiVersion?: string;
  readonly capabilityFingerprint?: string;
  readonly errorCode?: ComfyErrorCode;
}

export interface ComfyWorkflowValidation {
  readonly valid: boolean;
  readonly missingClasses: readonly string[];
}

export interface ComfySubmitRequest {
  readonly workflow: Readonly<Record<string, unknown>>;
  readonly extraData: Readonly<Record<string, unknown>>;
  readonly clientId?: string;
  readonly scenario?: ComfyScenario;
  readonly seed?: number;
}

export interface ComfySubmitResponse {
  readonly promptId: string;
  readonly queueNumber?: number;
  readonly nodeErrors?: Readonly<Record<string, unknown>>;
}

export interface ComfyQueueResponse {
  readonly queuePending: readonly string[];
  readonly queueRunning: readonly string[];
}

export interface ComfyOutputReference {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
  readonly mimeType: string;
  readonly format?: string;
}

export interface ComfyHistoryRecord {
  readonly promptId: string;
  readonly status: 'pending' | 'running' | 'success' | 'error' | 'interrupted';
  readonly completed: boolean;
  readonly extraData: Readonly<Record<string, unknown>>;
  readonly outputs: readonly ComfyOutputReference[];
  readonly workflow?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type ComfyMessageType =
  | 'status'
  | 'feature_flags'
  | 'execution_start'
  | 'execution_cached'
  | 'executing'
  | 'progress'
  | 'executed'
  | 'execution_success'
  | 'execution_error'
  | 'execution_interrupted';

export interface ComfyMessage {
  readonly type: ComfyMessageType;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ComfyEventStreamOptions {
  readonly promptId?: string;
  readonly signal?: AbortSignal;
}

export interface ComfyClient {
  checkReady(): Promise<ComfyReadiness>;
  getCapabilities(): Promise<ComfyCapabilities>;
  getObjectInfo(): Promise<ComfyObjectInfoResponse>;
  validateWorkflow(
    workflow: Readonly<Record<string, unknown>>,
  ): Promise<ComfyWorkflowValidation>;
  submitPrompt(request: ComfySubmitRequest): Promise<ComfySubmitResponse>;
  getQueue(): Promise<ComfyQueueResponse>;
  getHistory(promptId: string): Promise<ComfyHistoryRecord | null>;
  findHistoryByCorrelation(
    correlationId: string,
  ): Promise<ComfyHistoryRecord | null>;
  cancelPrompt(promptId?: string): Promise<void>;
  events(options?: ComfyEventStreamOptions): AsyncIterable<ComfyMessage>;
  downloadOutput(output: ComfyOutputReference): Promise<Uint8Array>;
}

export const EMPTY_OBJECT_INFO: ComfyObjectInfoResponse = {};

export type ComfyErrorCode =
  | 'COMFY_CONFIGURATION_INVALID'
  | 'COMFY_REQUEST_TIMEOUT'
  | 'COMFY_NETWORK_ERROR'
  | 'COMFY_HTTP_ERROR'
  | 'COMFY_PROTOCOL_ERROR'
  | 'COMFY_PROMPT_REJECTED'
  | 'COMFY_SUBMISSION_UNCERTAIN'
  | 'COMFY_STREAM_DISCONNECTED'
  | 'COMFY_OUTPUT_INVALID'
  | 'COMFY_OUTPUT_TOO_LARGE'
  | 'COMFY_UNAVAILABLE';

export class ComfyClientError extends Error {
  readonly code: ComfyErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: ComfyErrorCode,
    message: string,
    options: { readonly status?: number; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ComfyClientError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

export class ComfySubmissionUncertainError extends ComfyClientError {
  constructor(message = 'ComfyUI submission outcome is uncertain.') {
    super('COMFY_SUBMISSION_UNCERTAIN', message, { retryable: true });
    this.name = 'ComfySubmissionUncertainError';
  }
}

export class ComfyStreamDisconnectedError extends ComfyClientError {
  constructor(message = 'The ComfyUI event stream disconnected.') {
    super('COMFY_STREAM_DISCONNECTED', message, { retryable: true });
    this.name = 'ComfyStreamDisconnectedError';
  }
}

export class ComfyRequestTimeoutError extends ComfyClientError {
  constructor(message = 'ComfyUI request exceeded its deadline.') {
    super('COMFY_REQUEST_TIMEOUT', message, { retryable: true });
    this.name = 'ComfyRequestTimeoutError';
  }
}

export class ComfyPromptRejectedError extends ComfyClientError {
  constructor(message = 'ComfyUI rejected the prompt.') {
    super('COMFY_PROMPT_REJECTED', message, { retryable: false });
    this.name = 'ComfyPromptRejectedError';
  }
}

export function objectInfoClasses(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  if (isRecord(value.nodes)) return value.nodes;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeForFingerprint(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForFingerprint(item, depth + 1));
  }
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeForFingerprint(value[key], depth + 1)]),
  );
}

export function normalizeComfyObjectInfo(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const classes = objectInfoClasses(value);
  return Object.fromEntries(
    Object.entries(classes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([classType, definition]) => [
        classType,
        normalizeForFingerprint(definition),
      ]),
  );
}

export function computeComfyCapabilityFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeComfyObjectInfo(value)), 'utf8')
    .digest('hex');
}

// Keep the shorter names convenient for callers that only need a fingerprint.
export const comfyCapabilityFingerprint = computeComfyCapabilityFingerprint;
export const capabilityFingerprint = computeComfyCapabilityFingerprint;

interface FakeJob {
  readonly promptId: string;
  readonly queueNumber: number;
  readonly workflow: Readonly<Record<string, unknown>>;
  readonly extraData: Readonly<Record<string, unknown>>;
  readonly scenario: ComfyScenario;
  readonly output: ComfyOutputReference;
  readonly outputBytes: Uint8Array;
  status: ComfyHistoryRecord['status'];
  completed: boolean;
  events: ComfyMessage[];
  errorCode?: string;
  errorMessage?: string;
  started: boolean;
  executionScheduled: boolean;
}

type EventListener = (promptId: string, message: ComfyMessage) => void;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private closeError: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return { value, done: false };
        }
        if (this.closed) {
          if (this.closeError) throw this.closeError;
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export function createDeterministicFixtureBytes(seed: number): Uint8Array {
  const metadata = JSON.stringify({
    format: 'mp4',
    width: 960,
    height: 544,
    durationSeconds: 5,
    fps: 24,
    channels: 2,
    sampleRate: 32_000,
    movingTestPattern: true,
    seed,
  });
  const payload = Buffer.from(metadata, 'utf8');
  const header = Buffer.from('h3-fixture-mp4\0', 'utf8');
  const bytes = new Uint8Array(header.byteLength + payload.byteLength + 32);
  bytes.set(header);
  bytes.set(payload, header.byteLength);
  const digest = createHash('sha256')
    .update(bytes.subarray(0, header.byteLength + payload.byteLength))
    .digest();
  bytes.set(digest, header.byteLength + payload.byteLength);
  return bytes;
}

function loadGeneratedFixtureBytes(seed: number): Uint8Array {
  try {
    const fixturePath = process.env.H3_MEDIA_FIXTURE_PATH
      ? resolve(process.env.H3_MEDIA_FIXTURE_PATH)
      : resolve(process.cwd(), '.data/fixtures/h3-t2v-fixture.mp4');
    const bytes = readFileSync(fixturePath);
    if (bytes.byteLength > 0) return new Uint8Array(bytes);
  } catch {
    // The checked-in source tree intentionally does not contain generated media.
  }
  return createDeterministicFixtureBytes(seed);
}

const LEGACY_FAKE_OBJECT_INFO: ComfyObjectInfoResponse = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [['minimax_h3_fl2va_pruned_int8_convrot.safetensors']],
      },
    },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors']],
      },
    },
  },
  VAELoader: {
    input: {
      required: {
        vae_name: [
          [
            'minimax_h3_video_vae_fp16.safetensors',
            'minimax_h3_audio_vae_fp32.safetensors',
          ],
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
  // Retained for the Phase 3 compatibility client/tests.
  CLIPTextEncode: {},
  EmptyHunyuanLatentVideo: {},
  KSampler: {},
};

export class DeterministicFakeComfyService {
  readonly capabilities: ComfyCapabilities;
  private readonly jobs = new Map<string, FakeJob>();
  private readonly listeners = new Set<EventListener>();
  private uncertainSubmissionSeen = new Set<string>();
  private readonly submissionCounts = new Map<string, number>();
  private readonly outputBytes: (seed: number) => Uint8Array;
  private readonly objectInfo: ComfyObjectInfoResponse;
  private nextQueueNumber = 0;

  constructor(
    options: {
      readonly objectInfo?: ComfyObjectInfoResponse;
      readonly outputBytes?: (seed: number) => Uint8Array;
    } = {},
  ) {
    this.outputBytes = options.outputBytes ?? loadGeneratedFixtureBytes;
    this.objectInfo = options.objectInfo ?? LEGACY_FAKE_OBJECT_INFO;
    this.capabilities = {
      apiVersion: '0.0.1-fake',
      supportsWebSocket: true,
      supportsCancellation: true,
      preservesExtraData: true,
      capabilityFingerprint: computeComfyCapabilityFingerprint(
        this.getObjectInfo(),
      ),
    };
  }

  getObjectInfo(): ComfyObjectInfoResponse {
    return this.objectInfo;
  }

  getSystemStats(): ComfySystemStatsResponse {
    return {
      system: {
        os: 'fake',
        comfyui_version: this.capabilities.apiVersion,
        python_version: '3.12.0-fake',
        embedded_python: false,
      },
      devices: [],
    };
  }

  submit(request: ComfySubmitRequest): ComfySubmitResponse {
    const correlationId = String(request.extraData.correlation_id ?? '');
    this.submissionCounts.set(
      correlationId,
      (this.submissionCounts.get(correlationId) ?? 0) + 1,
    );
    const seed = request.seed ?? Number(request.extraData.seed ?? 0);
    const scenario = request.scenario ?? 'success';
    const existing = [...this.jobs.values()].find(
      (job) => job.extraData.correlation_id === correlationId && correlationId,
    );
    if (existing) {
      if (
        scenario === 'uncertain-submission' &&
        !this.uncertainSubmissionSeen.has(correlationId)
      ) {
        this.uncertainSubmissionSeen.add(correlationId);
        throw new ComfySubmissionUncertainError();
      }
      return { promptId: existing.promptId, queueNumber: existing.queueNumber };
    }
    const promptId = `fake-${createHash('sha256')
      .update(`${correlationId}:${seed}:${canonicalize(request.workflow)}`)
      .digest('hex')
      .slice(0, 24)}`;
    const output: ComfyOutputReference = {
      filename: `${promptId}.mp4`,
      subfolder: '',
      type: 'output',
      mimeType: 'video/mp4',
    };
    const job: FakeJob = {
      promptId,
      queueNumber: this.nextQueueNumber++,
      workflow: { ...request.workflow },
      extraData: { ...request.extraData },
      scenario,
      output,
      outputBytes: this.outputBytes(seed),
      status: 'pending',
      completed: false,
      events: [],
      started: false,
      executionScheduled: false,
    };
    this.jobs.set(promptId, job);
    if (scenario === 'uncertain-submission') {
      this.uncertainSubmissionSeen.add(correlationId);
      this.schedule(job);
      throw new ComfySubmissionUncertainError();
    }
    this.schedule(job);
    return { promptId, queueNumber: job.queueNumber };
  }

  private schedule(job: FakeJob): void {
    if (job.executionScheduled) return;
    job.executionScheduled = true;
    if (job.scenario === 'disconnect-reconcile') {
      setTimeout(() => {
        void this.execute(job);
      }, 0);
      return;
    }
    queueMicrotask(() => {
      void this.execute(job);
    });
  }

  private async execute(job: FakeJob): Promise<void> {
    if (job.scenario === 'timeout') {
      job.status = 'running';
      job.started = true;
      this.emit(job, {
        type: 'execution_start',
        data: { prompt_id: job.promptId },
      });
      return;
    }
    job.status = 'running';
    job.started = true;
    this.emit(job, {
      type: 'execution_start',
      data: { prompt_id: job.promptId },
    });
    this.emit(job, {
      type: 'executing',
      data: { prompt_id: job.promptId, node: '1', display_node: '1' },
    });
    const progress =
      job.scenario === 'duplicate-events' ? [50, 25, 25, 100] : [0, 50, 100];
    for (const value of progress) {
      this.emit(job, {
        type: 'progress',
        data: { prompt_id: job.promptId, node: '3', value, max: 100 },
      });
    }
    if (job.scenario === 'execution-failure') {
      job.status = 'error';
      job.completed = true;
      job.errorCode = 'COMFY_EXECUTION_FAILED';
      job.errorMessage = 'fixture execution failed at node 3';
      this.emit(job, {
        type: 'execution_error',
        data: {
          prompt_id: job.promptId,
          node_id: '3',
          exception_type: 'FixtureError',
          exception_message: job.errorMessage,
        },
      });
      return;
    }
    this.emit(job, {
      type: 'executed',
      data: {
        prompt_id: job.promptId,
        node: '4',
        output: { videos: [{ ...job.output }] },
      },
    });
    job.status = 'success';
    job.completed = true;
    this.emit(job, {
      type: 'execution_success',
      data: { prompt_id: job.promptId },
    });
  }

  private emit(job: FakeJob, message: ComfyMessage): void {
    job.events.push(message);
    for (const listener of this.listeners) {
      listener(job.promptId, message);
    }
  }

  queue(): ComfyQueueResponse {
    const jobs = [...this.jobs.values()];
    return {
      queuePending: jobs
        .filter((job) => job.status === 'pending')
        .map((job) => job.promptId),
      queueRunning: jobs
        .filter((job) => job.status === 'running')
        .map((job) => job.promptId),
    };
  }

  queueProtocol(): Readonly<{
    readonly queue_pending: readonly (readonly unknown[])[];
    readonly queue_running: readonly (readonly unknown[])[];
  }> {
    const entries = (status: 'pending' | 'running') =>
      [...this.jobs.values()]
        .filter((job) => job.status === status)
        .map(
          (job) =>
            [
              job.queueNumber,
              job.promptId,
              job.workflow,
              job.extraData,
              [],
            ] as const,
        );
    return {
      queue_pending: entries('pending'),
      queue_running: entries('running'),
    };
  }

  history(promptId: string): ComfyHistoryRecord | null {
    const job = this.jobs.get(promptId);
    if (!job) return null;
    const result: ComfyHistoryRecord = {
      promptId: job.promptId,
      status: job.status,
      completed: job.completed,
      extraData: { ...job.extraData },
      outputs: job.completed && job.status === 'success' ? [job.output] : [],
      workflow: { ...job.workflow },
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    };
    return result;
  }

  historyByCorrelation(correlationId: string): ComfyHistoryRecord | null {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.extraData.correlation_id === correlationId,
    );
    return job ? this.history(job.promptId) : null;
  }

  histories(): Readonly<Record<string, ComfyHistoryRecord>> {
    return Object.fromEntries(
      [...this.jobs.keys()].map((promptId) => [
        promptId,
        this.history(promptId),
      ]),
    ) as Readonly<Record<string, ComfyHistoryRecord>>;
  }

  eventsSnapshot(): readonly {
    readonly promptId: string;
    readonly message: ComfyMessage;
  }[] {
    return [...this.jobs.values()].flatMap((job) =>
      job.events.map((message) => ({ promptId: job.promptId, message })),
    );
  }

  submissionCount(correlationId: string): number {
    return this.submissionCounts.get(correlationId) ?? 0;
  }

  cancel(promptId?: string): void {
    const jobs = promptId
      ? [this.jobs.get(promptId)].filter((job): job is FakeJob => Boolean(job))
      : [...this.jobs.values()].filter((job) => !job.completed);
    for (const job of jobs) {
      if (job.completed) continue;
      job.status = 'interrupted';
      job.completed = true;
      this.emit(job, {
        type: 'execution_interrupted',
        data: { prompt_id: job.promptId },
      });
    }
  }

  output(output: ComfyOutputReference): Uint8Array {
    const promptId = output.filename.replace(/\.mp4$/, '');
    const job = this.jobs.get(promptId);
    if (!job?.completed || job.status !== 'success') {
      throw new Error('Fake Comfy output is not available.');
    }
    return new Uint8Array(job.outputBytes);
  }

  addListener(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stream(promptId?: string, signal?: AbortSignal): AsyncIterable<ComfyMessage> {
    const queue = new AsyncEventQueue<ComfyMessage>();
    const jobs = promptId
      ? [this.jobs.get(promptId)].filter((job): job is FakeJob => Boolean(job))
      : [...this.jobs.values()];
    const disconnect = jobs.some(
      (job) => job.scenario === 'disconnect-reconcile',
    );
    let delivered = 0;
    for (const job of jobs) {
      for (const message of job.events) {
        queue.push(message);
        delivered += 1;
        if (disconnect && message.type === 'execution_start') {
          queue.close(new ComfyStreamDisconnectedError());
          break;
        }
      }
    }
    if (
      !disconnect &&
      jobs.some((job) =>
        job.events.some(
          (message) =>
            message.type === 'execution_success' ||
            message.type === 'execution_error' ||
            message.type === 'execution_interrupted',
        ),
      )
    ) {
      queue.close();
    }
    const unsubscribe = this.addListener((eventPromptId, message) => {
      if (promptId && eventPromptId !== promptId) return;
      if (disconnect && delivered > 0) return;
      delivered += 1;
      queue.push(message);
      if (disconnect && message.type === 'execution_start') {
        queue.close(new ComfyStreamDisconnectedError());
      }
      if (
        message.type === 'execution_success' ||
        message.type === 'execution_error' ||
        message.type === 'execution_interrupted'
      ) {
        queue.close();
      }
    });
    const onAbort = (): void => queue.close(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const iterable = queue as AsyncIterable<ComfyMessage>;
    const iterator = iterable[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator](): AsyncIterator<ComfyMessage> {
        return {
          next: async () => iterator.next(),
          return: async () => {
            unsubscribe();
            signal?.removeEventListener('abort', onAbort);
            queue.close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

export class FakeComfyClient implements ComfyClient {
  readonly service: DeterministicFakeComfyService;

  constructor(service = new DeterministicFakeComfyService()) {
    this.service = service;
  }

  async checkReady(): Promise<ComfyReadiness> {
    return {
      ready: true,
      checkedAt: new Date().toISOString(),
      apiVersion: this.service.capabilities.apiVersion,
      capabilityFingerprint: this.service.capabilities.capabilityFingerprint,
    };
  }

  async getCapabilities(): Promise<ComfyCapabilities> {
    return this.service.capabilities;
  }

  async getObjectInfo(): Promise<ComfyObjectInfoResponse> {
    return this.service.getObjectInfo();
  }

  async validateWorkflow(
    workflow: Readonly<Record<string, unknown>>,
  ): Promise<ComfyWorkflowValidation> {
    const available = new Set(
      Object.keys(objectInfoClasses(this.service.getObjectInfo())),
    );
    const missingClasses = Object.values(workflow)
      .map((node) =>
        typeof node === 'object' && node !== null && 'class_type' in node
          ? String((node as { class_type: unknown }).class_type)
          : '',
      )
      .filter(
        (classType) => classType.length === 0 || !available.has(classType),
      );
    return { valid: missingClasses.length === 0, missingClasses };
  }

  async submitPrompt(
    request: ComfySubmitRequest,
  ): Promise<ComfySubmitResponse> {
    return this.service.submit(request);
  }

  async getQueue(): Promise<ComfyQueueResponse> {
    return this.service.queue();
  }

  async getHistory(promptId: string): Promise<ComfyHistoryRecord | null> {
    return this.service.history(promptId);
  }

  async findHistoryByCorrelation(
    correlationId: string,
  ): Promise<ComfyHistoryRecord | null> {
    return this.service.historyByCorrelation(correlationId);
  }

  async cancelPrompt(promptId?: string): Promise<void> {
    this.service.cancel(promptId);
  }

  events(options: ComfyEventStreamOptions = {}): AsyncIterable<ComfyMessage> {
    return this.service.stream(options.promptId, options.signal);
  }

  async downloadOutput(output: ComfyOutputReference): Promise<Uint8Array> {
    return this.service.output(output);
  }
}

export interface ComfyWebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
  send(data: string): void;
}

export interface ComfyWebSocketConstructor {
  new (url: string): ComfyWebSocketLike;
}

export interface ComfyWebSocketFactoryOptions {
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A Node-side gateway adapter may use these headers for the WebSocket
 * upgrade. The standard browser/Node WebSocket constructor cannot set
 * arbitrary headers, so the default transport deliberately never places the
 * bearer token in the URL. A production gateway must authenticate the
 * upgrade using this factory, mTLS, or an equivalent worker-only identity.
 */
export type ComfyWebSocketFactory = (
  url: string,
  options: ComfyWebSocketFactoryOptions,
) => ComfyWebSocketLike;

export interface HttpWsComfyClientOptions {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly clientId: string;
  readonly authToken?: string;
  readonly requestTimeoutMs?: number;
  readonly maxJsonResponseBytes?: number;
  readonly maxOutputBytes?: number;
  readonly historyLimit?: number;
  readonly fetchImpl?: typeof fetch;
  readonly webSocket?: ComfyWebSocketConstructor;
  readonly webSocketFactory?: ComfyWebSocketFactory;
}

export function normalizeComfyQueueResponse(
  value: unknown,
): ComfyQueueResponse {
  const record = isRecord(value) ? value : {};
  return {
    queuePending: queuePromptIds(record.queue_pending ?? record.queuePending),
    queueRunning: queuePromptIds(record.queue_running ?? record.queueRunning),
  };
}

function queuePromptIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const promptIds: string[] = [];
  for (const item of value) {
    const promptId =
      typeof item === 'string'
        ? item
        : Array.isArray(item) && typeof item[1] === 'string'
          ? item[1]
          : isRecord(item) && typeof item.prompt_id === 'string'
            ? item.prompt_id
            : isRecord(item) && typeof item.promptId === 'string'
              ? item.promptId
              : undefined;
    if (promptId && !promptIds.includes(promptId)) promptIds.push(promptId);
  }
  return promptIds;
}

function outputMimeType(filename: string, format: string | undefined): string {
  const hint = `${format ?? ''} ${filename}`.toLowerCase();
  if (hint.includes('webm')) return 'video/webm';
  if (hint.includes('gif')) return 'image/gif';
  if (hint.includes('mov')) return 'video/quicktime';
  return 'video/mp4';
}

function collectOutputReferences(
  value: unknown,
  output: ComfyOutputReference[],
  depth = 0,
): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectOutputReferences(item, output, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.filename === 'string' && value.filename.length > 0) {
    const format =
      typeof value.format === 'string'
        ? value.format
        : typeof value.output_format === 'string'
          ? value.output_format
          : undefined;
    output.push({
      filename: value.filename,
      subfolder: typeof value.subfolder === 'string' ? value.subfolder : '',
      type: typeof value.type === 'string' ? value.type : 'output',
      mimeType:
        typeof value.mimeType === 'string'
          ? value.mimeType
          : typeof value.mime_type === 'string'
            ? value.mime_type
            : outputMimeType(value.filename, format),
      ...(format ? { format } : {}),
    });
    return;
  }
  for (const child of Object.values(value)) {
    collectOutputReferences(child, output, depth + 1);
  }
}

function historyExtraData(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const direct = record.extra_data ?? record.extraData;
  if (isRecord(direct)) return direct;
  if (Array.isArray(record.prompt)) {
    // Official history stores [number, prompt_id, prompt, extra_data, ...].
    for (const index of [3, 1]) {
      const candidate = record.prompt[index];
      if (isRecord(candidate)) return candidate;
    }
  }
  return {};
}

function historyWorkflow(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (isRecord(record.workflow)) return record.workflow;
  if (Array.isArray(record.prompt) && isRecord(record.prompt[2])) {
    return record.prompt[2];
  }
  return undefined;
}

function normalizeHistoryRecord(
  promptId: string,
  value: unknown,
): ComfyHistoryRecord {
  if (!isRecord(value)) {
    throw new ComfyClientError(
      'COMFY_PROTOCOL_ERROR',
      'ComfyUI history response had an invalid record.',
    );
  }
  const statusRecord = isRecord(value.status) ? value.status : {};
  const statusValue = String(
    typeof value.status === 'string'
      ? value.status
      : (statusRecord.status_str ?? value.status_str ?? 'pending'),
  ).toLowerCase();
  const outputs: ComfyOutputReference[] = [];
  collectOutputReferences(value.outputs, outputs);
  const status: ComfyHistoryRecord['status'] =
    statusValue === 'success'
      ? 'success'
      : statusValue === 'error' || statusValue === 'failed'
        ? 'error'
        : statusValue === 'interrupted'
          ? 'interrupted'
          : statusValue === 'running' || statusValue === 'executing'
            ? 'running'
            : statusRecord.completed === true
              ? outputs.length > 0
                ? 'success'
                : 'error'
              : 'pending';
  const completed =
    typeof statusRecord.completed === 'boolean'
      ? statusRecord.completed
      : typeof value.completed === 'boolean'
        ? value.completed
        : status === 'success' ||
          status === 'error' ||
          status === 'interrupted';
  const errorCode =
    typeof value.exception_type === 'string'
      ? value.exception_type
      : typeof value.error_code === 'string'
        ? value.error_code
        : undefined;
  const errorMessage =
    typeof value.exception_message === 'string'
      ? value.exception_message
      : typeof value.error_message === 'string'
        ? value.error_message
        : undefined;
  const workflow = historyWorkflow(value);
  return {
    promptId,
    status,
    completed,
    extraData: historyExtraData(value),
    outputs,
    ...(workflow ? { workflow } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function isHistoryRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (Object.hasOwn(value, 'status') || Object.hasOwn(value, 'outputs'))
  );
}

function isTerminalMessage(message: ComfyMessage): boolean {
  return (
    message.type === 'execution_success' ||
    message.type === 'execution_error' ||
    message.type === 'execution_interrupted'
  );
}

function parseComfyMessage(value: unknown): ComfyMessage | undefined {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    !isRecord(value.data)
  ) {
    return undefined;
  }
  const supported: ReadonlySet<string> = new Set([
    'status',
    'feature_flags',
    'execution_start',
    'execution_cached',
    'executing',
    'progress',
    'executed',
    'execution_success',
    'execution_error',
    'execution_interrupted',
  ]);
  if (!supported.has(value.type)) return undefined;
  return { type: value.type as ComfyMessageType, data: value.data };
}

export class HttpWsComfyClient implements ComfyClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly clientId: string;
  private readonly authToken?: string;
  private readonly requestTimeoutMs: number;
  private readonly maxJsonResponseBytes: number;
  private readonly maxOutputBytes: number;
  private readonly historyLimit: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocket?: ComfyWebSocketConstructor;
  private readonly webSocketFactory?: ComfyWebSocketFactory;

  constructor(options: HttpWsComfyClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    const wsUrl = new URL(options.wsUrl);
    if (!['http:', 'https:'].includes(baseUrl.protocol)) {
      throw new ComfyClientError(
        'COMFY_CONFIGURATION_INVALID',
        'ComfyUI base URL must use HTTP or HTTPS.',
      );
    }
    if (!['ws:', 'wss:'].includes(wsUrl.protocol)) {
      throw new ComfyClientError(
        'COMFY_CONFIGURATION_INVALID',
        'ComfyUI WebSocket URL must use WS or WSS.',
      );
    }
    if (!options.clientId.trim()) {
      throw new ComfyClientError(
        'COMFY_CONFIGURATION_INVALID',
        'ComfyUI client ID must be non-blank.',
      );
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    const maxJsonResponseBytes =
      options.maxJsonResponseBytes ?? DEFAULT_MAX_JSON_RESPONSE_BYTES;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 100 ||
      !Number.isSafeInteger(maxJsonResponseBytes) ||
      maxJsonResponseBytes < 1 ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      !Number.isSafeInteger(historyLimit) ||
      historyLimit < 1
    ) {
      throw new ComfyClientError(
        'COMFY_CONFIGURATION_INVALID',
        'ComfyUI client limits are invalid.',
      );
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/, '');
    this.wsUrl = wsUrl.toString();
    this.clientId = options.clientId;
    if (options.authToken) this.authToken = options.authToken;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxJsonResponseBytes = maxJsonResponseBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.historyLimit = historyLimit;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.webSocket) {
      this.webSocket = options.webSocket;
    } else {
      const globalWebSocket = (
        globalThis as unknown as {
          readonly WebSocket?: unknown;
        }
      ).WebSocket;
      if (typeof globalWebSocket === 'function') {
        this.webSocket = globalWebSocket as ComfyWebSocketConstructor;
      }
    }
    if (options.webSocketFactory)
      this.webSocketFactory = options.webSocketFactory;
  }

  async checkReady(): Promise<ComfyReadiness> {
    const checkedAt = new Date().toISOString();
    try {
      const [systemStats, objectInfo] = await Promise.all([
        this.getJson<unknown>('/system_stats'),
        this.getObjectInfo(),
      ]);
      if (!isRecord(systemStats)) {
        throw new ComfyClientError(
          'COMFY_PROTOCOL_ERROR',
          'ComfyUI system stats response was invalid.',
        );
      }
      const system = isRecord(systemStats.system)
        ? systemStats.system
        : systemStats;
      const apiVersion =
        typeof system.comfyui_version === 'string'
          ? system.comfyui_version
          : 'unknown';
      return {
        ready: true,
        checkedAt,
        apiVersion,
        capabilityFingerprint: computeComfyCapabilityFingerprint(objectInfo),
      };
    } catch (error) {
      return {
        ready: false,
        checkedAt,
        errorCode:
          error instanceof ComfyClientError ? error.code : 'COMFY_UNAVAILABLE',
      };
    }
  }

  async getCapabilities(): Promise<ComfyCapabilities> {
    const readiness = await this.checkReady();
    if (!readiness.ready || !readiness.capabilityFingerprint) {
      throw new ComfyClientError('COMFY_UNAVAILABLE', 'ComfyUI is not ready.', {
        retryable: true,
      });
    }
    return {
      apiVersion: readiness.apiVersion ?? 'unknown',
      supportsWebSocket: true,
      supportsCancellation: true,
      preservesExtraData: true,
      capabilityFingerprint: readiness.capabilityFingerprint,
    };
  }

  async getObjectInfo(): Promise<ComfyObjectInfoResponse> {
    const value = await this.getJson<unknown>('/object_info');
    if (!isRecord(value)) {
      throw new ComfyClientError(
        'COMFY_PROTOCOL_ERROR',
        'ComfyUI object information response was invalid.',
      );
    }
    return objectInfoClasses(value);
  }

  async validateWorkflow(
    workflow: Readonly<Record<string, unknown>>,
  ): Promise<ComfyWorkflowValidation> {
    const info = await this.getObjectInfo();
    const available = new Set(Object.keys(objectInfoClasses(info)));
    const missingClasses = [
      ...new Set(
        Object.values(workflow)
          .map((node) =>
            isRecord(node) && 'class_type' in node
              ? String(node.class_type)
              : '',
          )
          .filter(
            (classType) => classType.length === 0 || !available.has(classType),
          ),
      ),
    ];
    return { valid: missingClasses.length === 0, missingClasses };
  }

  async submitPrompt(
    request: ComfySubmitRequest,
  ): Promise<ComfySubmitResponse> {
    const extraData: Record<string, unknown> = { ...request.extraData };
    if (
      request.scenario !== undefined &&
      !Object.hasOwn(extraData, 'scenario')
    ) {
      extraData.scenario = request.scenario;
    }
    if (request.seed !== undefined && !Object.hasOwn(extraData, 'seed')) {
      extraData.seed = request.seed;
    }
    let body: string;
    try {
      body = JSON.stringify({
        prompt: request.workflow,
        client_id: request.clientId ?? this.clientId,
        extra_data: extraData,
      });
    } catch {
      throw new ComfyClientError(
        'COMFY_PROTOCOL_ERROR',
        'ComfyUI prompt payload is not valid JSON.',
      );
    }
    let response: Response;
    let value: Record<string, unknown>;
    try {
      response = await this.request('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (error) {
      if (
        error instanceof ComfyRequestTimeoutError ||
        (error instanceof ComfyClientError &&
          error.code === 'COMFY_NETWORK_ERROR')
      ) {
        throw new ComfySubmissionUncertainError();
      }
      throw error;
    }
    if (response.status >= 500) {
      throw new ComfySubmissionUncertainError();
    }
    if (!response.ok) {
      throw new ComfyPromptRejectedError();
    }
    try {
      value = await this.parseJsonResponse<Record<string, unknown>>(response);
    } catch (error) {
      if (
        error instanceof ComfyRequestTimeoutError ||
        (error instanceof ComfyClientError &&
          error.code === 'COMFY_NETWORK_ERROR')
      ) {
        throw new ComfySubmissionUncertainError();
      }
      throw error;
    }
    if (Object.hasOwn(value, 'error')) {
      throw new ComfyPromptRejectedError();
    }
    const promptId = value.prompt_id ?? value.promptId;
    if (typeof promptId !== 'string' || promptId.length === 0) {
      throw new ComfyClientError(
        'COMFY_PROTOCOL_ERROR',
        'ComfyUI submission response did not include a prompt ID.',
      );
    }
    return {
      promptId,
      ...(typeof value.number === 'number'
        ? { queueNumber: value.number }
        : {}),
      ...(isRecord(value.node_errors) ? { nodeErrors: value.node_errors } : {}),
    };
  }

  async getQueue(): Promise<ComfyQueueResponse> {
    let value: unknown;
    try {
      value = await this.getJson<unknown>('/queue');
    } catch (error) {
      // The pinned backend also retains GET /prompt as its legacy queue-info
      // route. Prefer the official tuple endpoint and use the legacy route
      // only when a gateway/backend does not expose /queue.
      if (
        !(error instanceof ComfyClientError) ||
        error.code !== 'COMFY_HTTP_ERROR' ||
        error.status !== 404
      ) {
        throw error;
      }
      value = await this.getJson<unknown>('/prompt');
    }
    return normalizeComfyQueueResponse(value);
  }

  async getHistory(promptId: string): Promise<ComfyHistoryRecord | null> {
    const response = await this.request(
      `/history/${encodeURIComponent(promptId)}`,
    );
    if (response.status === 404) return null;
    const value = await this.parseJsonResponse<unknown>(response);
    if (isRecord(value) && Object.hasOwn(value, promptId)) {
      return normalizeHistoryRecord(promptId, value[promptId]);
    }
    if (isHistoryRecord(value)) return normalizeHistoryRecord(promptId, value);
    // ComfyUI returns an empty object for an unknown history identifier.
    return null;
  }

  async findHistoryByCorrelation(
    correlationId: string,
  ): Promise<ComfyHistoryRecord | null> {
    const value = await this.getJson<unknown>(
      `/history?max_items=${this.historyLimit}`,
    );
    if (!isRecord(value)) return null;
    for (const [promptId, rawRecord] of Object.entries(value)) {
      if (!isHistoryRecord(rawRecord)) continue;
      const normalized = normalizeHistoryRecord(promptId, rawRecord);
      if (normalized.extraData.correlation_id === correlationId) {
        return normalized;
      }
    }
    return null;
  }

  async cancelPrompt(promptId?: string): Promise<void> {
    const response = await this.request('/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
    });
    if (!response.ok) {
      throw this.httpError(response.status);
    }
  }

  events(options: ComfyEventStreamOptions = {}): AsyncIterable<ComfyMessage> {
    const queue = new AsyncEventQueue<ComfyMessage>();
    const url = new URL(this.wsUrl);
    url.searchParams.set('clientId', this.clientId);
    let socket: ComfyWebSocketLike;
    try {
      const headers = this.authToken
        ? { authorization: `Bearer ${this.authToken}` }
        : {};
      socket = this.webSocketFactory
        ? this.webSocketFactory(url.toString(), { headers })
        : this.webSocket
          ? new this.webSocket(url.toString())
          : (() => {
              throw new ComfyClientError(
                'COMFY_CONFIGURATION_INVALID',
                'A WebSocket transport is not available.',
              );
            })();
    } catch (error) {
      queue.close(
        error instanceof Error ? error : new ComfyStreamDisconnectedError(),
      );
      return queue;
    }

    let closedByConsumer = false;
    let terminalObserved = false;
    let openTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        if (terminalObserved || closedByConsumer) return;
        try {
          socket.close();
        } finally {
          queue.close(
            new ComfyRequestTimeoutError('ComfyUI WebSocket open timed out.'),
          );
        }
      },
      this.requestTimeoutMs,
    );
    const cleanup = (): void => {
      if (openTimer !== undefined) {
        clearTimeout(openTimer);
        openTimer = undefined;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      closedByConsumer = true;
      cleanup();
      try {
        socket.close();
      } finally {
        queue.close(options.signal?.reason);
      }
    };
    socket.onopen = () => {
      if (openTimer !== undefined) {
        clearTimeout(openTimer);
        openTimer = undefined;
      }
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        queue.close(
          new ComfyClientError(
            'COMFY_PROTOCOL_ERROR',
            'ComfyUI WebSocket message was not valid JSON.',
          ),
        );
        return;
      }
      const message = parseComfyMessage(parsed);
      if (!message) return;
      const promptId =
        typeof message.data.prompt_id === 'string'
          ? message.data.prompt_id
          : '';
      const matchesPrompt = !options.promptId || promptId === options.promptId;
      if (!matchesPrompt) return;
      queue.push(message);
      if (isTerminalMessage(message)) {
        terminalObserved = true;
        cleanup();
        queue.close();
      }
    };
    socket.onerror = () => {
      cleanup();
      if (!closedByConsumer && !terminalObserved) {
        queue.close(new ComfyStreamDisconnectedError());
      }
    };
    socket.onclose = () => {
      cleanup();
      if (!closedByConsumer && !terminalObserved) {
        queue.close(new ComfyStreamDisconnectedError());
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const iterator = queue[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator](): AsyncIterator<ComfyMessage> {
        return {
          next: async () => iterator.next(),
          return: async () => {
            closedByConsumer = true;
            cleanup();
            socket.close();
            queue.close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async downloadOutput(output: ComfyOutputReference): Promise<Uint8Array> {
    validateOutputReference(output);
    const url = new URL(`${this.baseUrl}/view`);
    url.searchParams.set('filename', output.filename);
    url.searchParams.set('subfolder', output.subfolder);
    url.searchParams.set('type', output.type);
    const response = await this.request(url.toString());
    if (!response.ok) throw this.httpError(response.status);
    return this.readResponseBytes(response, this.maxOutputBytes, true);
  }

  private async getJson<Value>(path: string): Promise<Value> {
    const response = await this.request(path);
    return this.parseJsonResponse<Value>(response);
  }

  private async parseJsonResponse<Value>(response: Response): Promise<Value> {
    if (!response.ok) throw this.httpError(response.status);
    const bytes = await this.readResponseBytes(
      response,
      this.maxJsonResponseBytes,
      false,
    );
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as Value;
    } catch {
      throw new ComfyClientError(
        'COMFY_PROTOCOL_ERROR',
        'ComfyUI returned invalid JSON.',
      );
    }
  }

  private async readResponseBytes(
    response: Response,
    maxBytes: number,
    output: boolean,
  ): Promise<Uint8Array> {
    const contentLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new ComfyClientError(
        output ? 'COMFY_OUTPUT_TOO_LARGE' : 'COMFY_PROTOCOL_ERROR',
        output
          ? 'ComfyUI output exceeded the configured size limit.'
          : 'ComfyUI response exceeded the configured size limit.',
      );
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const bodyPromise = response.arrayBuffer();
      const timeoutPromise = new Promise<ArrayBuffer>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new ComfyRequestTimeoutError()),
          this.requestTimeoutMs,
        );
      });
      const bytes = new Uint8Array(
        await Promise.race([bodyPromise, timeoutPromise]),
      );
      if (bytes.byteLength > maxBytes) {
        throw new ComfyClientError(
          output ? 'COMFY_OUTPUT_TOO_LARGE' : 'COMFY_PROTOCOL_ERROR',
          output
            ? 'ComfyUI output exceeded the configured size limit.'
            : 'ComfyUI response exceeded the configured size limit.',
        );
      }
      return bytes;
    } catch (error) {
      if (error instanceof ComfyClientError) throw error;
      throw new ComfyClientError(
        'COMFY_NETWORK_ERROR',
        'ComfyUI response body could not be read.',
        { retryable: true },
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private async request(
    pathOrUrl: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const headers = new Headers(init.headers);
    if (this.authToken) {
      headers.set('authorization', `Bearer ${this.authToken}`);
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const responsePromise = this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new ComfyRequestTimeoutError());
        }, this.requestTimeoutMs);
      });
      return await Promise.race([responsePromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof ComfyClientError) throw error;
      if (controller.signal.aborted) throw new ComfyRequestTimeoutError();
      throw new ComfyClientError(
        'COMFY_NETWORK_ERROR',
        'ComfyUI request failed before a response was received.',
        { retryable: true },
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private httpError(status: number): ComfyClientError {
    return new ComfyClientError(
      'COMFY_HTTP_ERROR',
      `ComfyUI request failed with HTTP status ${status}.`,
      { status, retryable: status >= 500 },
    );
  }
}

function validateOutputReference(output: ComfyOutputReference): void {
  const validPart = (value: string, allowSlash: boolean): boolean => {
    if (
      (!allowSlash && !value) ||
      value.includes('\0') ||
      value.startsWith('/') ||
      value.startsWith('\\')
    ) {
      return false;
    }
    const segments = value.split(/[\\/]/u);
    if (allowSlash && value.length === 0) return true;
    return (
      (allowSlash || segments.length === 1) &&
      segments.every(
        (segment) => segment.length > 0 && segment !== '..' && segment !== '.',
      )
    );
  };
  if (
    !validPart(output.filename, false) ||
    !validPart(output.subfolder, true)
  ) {
    throw new ComfyClientError(
      'COMFY_OUTPUT_INVALID',
      'ComfyUI returned an unsafe output reference.',
    );
  }
}
