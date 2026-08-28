export interface ArtifactStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export const LOCAL_ARTIFACT_PREFIX = '.data/artifacts' as const;
