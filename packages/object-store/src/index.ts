import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';

export interface ArtifactPutInput {
  readonly artifactId: string;
  readonly body: Uint8Array | AsyncIterable<Uint8Array>;
  readonly mimeType: string;
}

export interface StoredArtifactObject {
  readonly artifactId: string;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ArtifactStore {
  put(input: ArtifactPutInput): Promise<StoredArtifactObject>;
  put(
    artifactId: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    mimeType?: string,
  ): Promise<StoredArtifactObject>;
  open(artifactId: string): Promise<Readable>;
  read(artifactId: string): Promise<Uint8Array>;
  metadata(artifactId: string): Promise<StoredArtifactObject | null>;
  exists(artifactId: string): Promise<boolean>;
  deleteForTestCleanup(artifactId: string): Promise<void>;
}

export const LOCAL_ARTIFACT_PREFIX = '.data/artifacts' as const;

function assertArtifactId(artifactId: string): void {
  if (
    !artifactId.trim() ||
    artifactId.includes('/') ||
    artifactId.includes('\\') ||
    artifactId === '.' ||
    artifactId === '..'
  ) {
    throw new Error('Artifact identifiers cannot contain path traversal.');
  }
}

function assertMimeType(mimeType: string): void {
  if (!/^[^\s/]+\/[^\s/]+$/.test(mimeType)) {
    throw new Error('Artifact MIME type is invalid.');
  }
}

function objectKeyFor(artifactId: string): string {
  assertArtifactId(artifactId);
  const digest = createHash('sha256')
    .update(`h3-videoops-artifact:${artifactId}`)
    .digest('hex');
  return `objects/${digest}.data`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rootRelative = relative(root, candidate);
  return (
    rootRelative === '' ||
    (!rootRelative.startsWith('..') && !isAbsolute(rootRelative))
  );
}

export class LocalArtifactStore implements ArtifactStore {
  readonly root: string;
  private readonly metadataByArtifactId = new Map<
    string,
    StoredArtifactObject
  >();

  constructor(root: string = LOCAL_ARTIFACT_PREFIX) {
    this.root = resolve(root);
  }

  async put(input: ArtifactPutInput): Promise<StoredArtifactObject>;
  async put(
    artifactId: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    mimeType?: string,
  ): Promise<StoredArtifactObject>;
  async put(
    inputOrArtifactId: ArtifactPutInput | string,
    body?: Uint8Array | AsyncIterable<Uint8Array>,
    mimeType = 'application/octet-stream',
  ): Promise<StoredArtifactObject> {
    const input: ArtifactPutInput =
      typeof inputOrArtifactId === 'string'
        ? {
            artifactId: inputOrArtifactId,
            body: body ?? new Uint8Array(),
            mimeType,
          }
        : inputOrArtifactId;
    assertArtifactId(input.artifactId);
    assertMimeType(input.mimeType);

    const objectKey = objectKeyFor(input.artifactId);
    const destination = resolve(this.root, objectKey);
    if (!isWithinRoot(this.root, destination)) {
      throw new Error('Artifact path escapes the configured root.');
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(
      dirname(destination),
      `.tmp-${createHash('sha256')
        .update(`${input.artifactId}:${Date.now()}:${Math.random()}`)
        .digest('hex')}`,
    );

    const handle = await open(temporary, 'wx');
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      if (input.body instanceof Uint8Array) {
        hash.update(input.body);
        byteSize += input.body.byteLength;
        await handle.write(input.body);
      } else {
        for await (const chunk of input.body) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error('Artifact streams must yield Uint8Array chunks.');
          }
          hash.update(chunk);
          byteSize += chunk.byteLength;
          await handle.write(chunk);
        }
      }
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    const result: StoredArtifactObject = {
      artifactId: input.artifactId,
      objectKey,
      mimeType: input.mimeType,
      byteSize,
      sha256: hash.digest('hex'),
    };
    this.metadataByArtifactId.set(input.artifactId, result);
    return result;
  }

  async open(artifactId: string): Promise<Readable> {
    const destination = this.pathFor(artifactId);
    await access(destination);
    return createReadStream(destination);
  }

  async read(artifactId: string): Promise<Uint8Array> {
    const stream = await this.open(artifactId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async metadata(artifactId: string): Promise<StoredArtifactObject | null> {
    const known = this.metadataByArtifactId.get(artifactId);
    if (known) {
      return { ...known };
    }
    try {
      const file = this.pathFor(artifactId);
      const fileStats = await stat(file);
      if (!fileStats.isFile()) {
        return null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async exists(artifactId: string): Promise<boolean> {
    try {
      await access(this.pathFor(artifactId));
      return true;
    } catch {
      return false;
    }
  }

  async deleteForTestCleanup(artifactId: string): Promise<void> {
    await rm(this.pathFor(artifactId), { force: true });
    this.metadataByArtifactId.delete(artifactId);
  }

  private pathFor(artifactId: string): string {
    const destination = resolve(this.root, objectKeyFor(artifactId));
    if (!isWithinRoot(this.root, destination)) {
      throw new Error('Artifact path escapes the configured root.');
    }
    return destination;
  }
}

export function createLocalArtifactStore(
  root: string = LOCAL_ARTIFACT_PREFIX,
): LocalArtifactStore {
  return new LocalArtifactStore(root);
}
