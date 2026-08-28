export interface ComfyObjectInfoResponse {
  readonly nodes: Readonly<Record<string, unknown>>;
}

export interface ComfyHealthResponse {
  readonly service: 'fake-comfy';
  readonly status: 'ok';
}

export interface ComfyClient {
  getObjectInfo(): Promise<ComfyObjectInfoResponse>;
}

export const EMPTY_OBJECT_INFO: ComfyObjectInfoResponse = { nodes: {} };
