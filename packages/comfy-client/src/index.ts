import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ComfyObjectInfoResponse {
  readonly nodes: Readonly<Record<string, unknown>>;
}

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
}

export interface ComfyHistoryRecord {
  readonly promptId: string;
  readonly status: 'pending' | 'running' | 'success' | 'error' | 'interrupted';
  readonly completed: boolean;
  readonly extraData: Readonly<Record<string, unknown>>;
  readonly outputs: readonly ComfyOutputReference[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type ComfyMessageType =
  | 'execution_start'
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

export const EMPTY_OBJECT_INFO: ComfyObjectInfoResponse = { nodes: {} };

export class ComfySubmissionUncertainError extends Error {
  constructor(message = 'ComfyUI submission outcome is uncertain.') {
    super(message);
    this.name = 'ComfySubmissionUncertainError';
  }
}

export class ComfyStreamDisconnectedError extends Error {
  constructor(message = 'The ComfyUI event stream disconnected.') {
    super(message);
    this.name = 'ComfyStreamDisconnectedError';
  }
}

interface FakeJob {
  readonly promptId: string;
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
    const bytes = readFileSync(
      resolve(process.cwd(), '.data/fixtures/h3-t2v-fixture.mp4'),
    );
    if (bytes.byteLength > 0) return new Uint8Array(bytes);
  } catch {
    // The checked-in source tree intentionally does not contain generated media.
  }
  return createDeterministicFixtureBytes(seed);
}

export class DeterministicFakeComfyService {
  readonly capabilities: ComfyCapabilities = {
    apiVersion: '0.0.1-fake',
    supportsWebSocket: true,
    supportsCancellation: true,
    preservesExtraData: true,
  };
  private readonly jobs = new Map<string, FakeJob>();
  private readonly listeners = new Set<EventListener>();
  private uncertainSubmissionSeen = new Set<string>();
  private readonly submissionCounts = new Map<string, number>();
  private readonly outputBytes: (seed: number) => Uint8Array;

  constructor(
    options: { readonly outputBytes?: (seed: number) => Uint8Array } = {},
  ) {
    this.outputBytes = options.outputBytes ?? loadGeneratedFixtureBytes;
  }

  getObjectInfo(): ComfyObjectInfoResponse {
    return {
      nodes: {
        CLIPTextEncode: {},
        EmptyHunyuanLatentVideo: {},
        KSampler: {},
        SaveVideo: {},
      },
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
      return { promptId: existing.promptId };
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
    return { promptId };
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

  history(promptId: string): ComfyHistoryRecord | null {
    const job = this.jobs.get(promptId);
    if (!job) return null;
    const result: ComfyHistoryRecord = {
      promptId: job.promptId,
      status: job.status,
      completed: job.completed,
      extraData: { ...job.extraData },
      outputs: job.completed && job.status === 'success' ? [job.output] : [],
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

  async getCapabilities(): Promise<ComfyCapabilities> {
    return this.service.capabilities;
  }

  async getObjectInfo(): Promise<ComfyObjectInfoResponse> {
    return this.service.getObjectInfo();
  }

  async validateWorkflow(
    workflow: Readonly<Record<string, unknown>>,
  ): Promise<ComfyWorkflowValidation> {
    const available = new Set(Object.keys(this.service.getObjectInfo().nodes));
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

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
  send(data: string): void;
}

interface WebSocketConstructor {
  new (url: string): WebSocketLike;
}

export interface HttpWsComfyClientOptions {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly clientId: string;
  readonly fetchImpl?: typeof fetch;
  readonly webSocket?: WebSocketConstructor;
}

export class HttpWsComfyClient implements ComfyClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocket: WebSocketConstructor;

  constructor(options: HttpWsComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.wsUrl = options.wsUrl;
    this.clientId = options.clientId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocket =
      options.webSocket ??
      (globalThis.WebSocket as unknown as WebSocketConstructor);
  }

  async getCapabilities(): Promise<ComfyCapabilities> {
    return {
      apiVersion: 'official-subset',
      supportsWebSocket: true,
      supportsCancellation: true,
      preservesExtraData: true,
    };
  }

  async getObjectInfo(): Promise<ComfyObjectInfoResponse> {
    return this.getJson<ComfyObjectInfoResponse>('/object_info');
  }

  async validateWorkflow(
    workflow: Readonly<Record<string, unknown>>,
  ): Promise<ComfyWorkflowValidation> {
    const info = await this.getObjectInfo();
    const available = new Set(Object.keys(info.nodes));
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
    const response = await this.fetchImpl(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: request.workflow,
        extra_data: request.extraData,
        client_id: request.clientId ?? this.clientId,
      }),
    });
    if (response.status === 504) {
      throw new ComfySubmissionUncertainError();
    }
    const value = await this.parseResponse<Record<string, unknown>>(response);
    const promptId = value.prompt_id ?? value.promptId;
    if (typeof promptId !== 'string' || !promptId) {
      throw new Error('Comfy submission response did not include a prompt ID.');
    }
    return { promptId };
  }

  async getQueue(): Promise<ComfyQueueResponse> {
    const value = await this.getJson<Record<string, unknown>>('/prompt');
    return {
      queuePending: this.stringArray(value.queue_pending ?? value.queuePending),
      queueRunning: this.stringArray(value.queue_running ?? value.queueRunning),
    };
  }

  async getHistory(promptId: string): Promise<ComfyHistoryRecord | null> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/history/${encodeURIComponent(promptId)}`,
    );
    if (response.status === 404) return null;
    const value = await this.parseResponse<Record<string, unknown>>(response);
    return this.normalizeHistory(promptId, value[promptId] ?? value);
  }

  async findHistoryByCorrelation(
    correlationId: string,
  ): Promise<ComfyHistoryRecord | null> {
    const queue = await this.getJson<Record<string, unknown>>('/history');
    for (const [promptId, value] of Object.entries(queue)) {
      const normalized = this.normalizeHistory(promptId, value);
      if (normalized.extraData.correlation_id === correlationId)
        return normalized;
    }
    return null;
  }

  async cancelPrompt(promptId?: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `Comfy cancellation failed with status ${response.status}.`,
      );
    }
  }

  events(options: ComfyEventStreamOptions = {}): AsyncIterable<ComfyMessage> {
    const queue = new AsyncEventQueue<ComfyMessage>();
    const url = new URL(this.wsUrl);
    url.searchParams.set('clientId', this.clientId);
    const socket = new this.webSocket(url.toString());
    socket.onopen = () => undefined;
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as ComfyMessage;
        const promptId = String(message.data.prompt_id ?? '');
        const matchesPrompt =
          !options.promptId || promptId === options.promptId;
        if (matchesPrompt) queue.push(message);
        if (
          matchesPrompt &&
          (message.type === 'execution_success' ||
            message.type === 'execution_error' ||
            message.type === 'execution_interrupted')
        ) {
          queue.close();
        }
      } catch {
        queue.close(new Error('Comfy WebSocket message was not valid JSON.'));
      }
    };
    socket.onerror = () => queue.close(new ComfyStreamDisconnectedError());
    socket.onclose = () => queue.close();
    const onAbort = (): void => {
      socket.close();
      queue.close(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const iterator = queue[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator](): AsyncIterator<ComfyMessage> {
        return {
          next: async () => iterator.next(),
          return: async () => {
            socket.close();
            options.signal?.removeEventListener('abort', onAbort);
            queue.close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async downloadOutput(output: ComfyOutputReference): Promise<Uint8Array> {
    const url = new URL(`${this.baseUrl}/view`);
    url.searchParams.set('filename', output.filename);
    url.searchParams.set('subfolder', output.subfolder);
    url.searchParams.set('type', output.type);
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `Comfy output download failed with status ${response.status}.`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async getJson<Value>(path: string): Promise<Value> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`);
    return this.parseResponse<Value>(response);
  }

  private async parseResponse<Value>(response: Response): Promise<Value> {
    if (!response.ok) {
      throw new Error(`Comfy request failed with status ${response.status}.`);
    }
    return (await response.json()) as Value;
  }

  private stringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private normalizeHistory(
    promptId: string,
    value: unknown,
  ): ComfyHistoryRecord {
    const record = value as Record<string, unknown>;
    const statusRecord = (record.status ?? {}) as Record<string, unknown>;
    const statusValue = String(
      typeof record.status === 'string'
        ? record.status
        : (statusRecord.status_str ?? record.status_str ?? 'pending'),
    );
    const status: ComfyHistoryRecord['status'] =
      statusValue === 'success'
        ? 'success'
        : statusValue === 'error'
          ? 'error'
          : statusValue === 'interrupted'
            ? 'interrupted'
            : record.outputs
              ? 'running'
              : 'pending';
    const extraData = (record.extra_data ?? record.extraData ?? {}) as Readonly<
      Record<string, unknown>
    >;
    const rawOutputs = record.outputs;
    const outputs = (
      Array.isArray(rawOutputs)
        ? rawOutputs
        : Object.values((rawOutputs ?? {}) as Record<string, unknown>).flatMap(
            (nodeOutput) => {
              if (typeof nodeOutput !== 'object' || nodeOutput === null)
                return [];
              const outputRecord = nodeOutput as Record<string, unknown>;
              return Object.values(outputRecord).flatMap((valueOutput) =>
                Array.isArray(valueOutput) ? valueOutput : [],
              );
            },
          )
    )
      .filter(
        (output): output is ComfyOutputReference =>
          typeof output === 'object' &&
          output !== null &&
          'filename' in output &&
          typeof (output as { filename: unknown }).filename === 'string',
      )
      .map((output) => ({
        filename: output.filename,
        subfolder: typeof output.subfolder === 'string' ? output.subfolder : '',
        type: typeof output.type === 'string' ? output.type : 'output',
        mimeType:
          typeof output.mimeType === 'string' ? output.mimeType : 'video/mp4',
      }));
    return {
      promptId,
      status,
      completed: Boolean(
        statusRecord.completed ??
          record.completed ??
          (status === 'success' ||
            status === 'error' ||
            status === 'interrupted'),
      ),
      extraData,
      outputs,
      ...(record.exception_type
        ? { errorCode: String(record.exception_type) }
        : {}),
      ...(record.exception_message
        ? { errorMessage: String(record.exception_message) }
        : {}),
    };
  }
}
