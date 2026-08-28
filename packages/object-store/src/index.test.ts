import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalArtifactStore } from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('local artifact store', () => {
  it('stores bytes atomically with opaque keys and verifiable metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h3-artifact-test-'));
    roots.push(root);
    const store = createLocalArtifactStore(root);
    const bytes = new TextEncoder().encode('synthetic fixture bytes');

    const stored = await store.put({
      artifactId: 'artifact-1',
      body: bytes,
      mimeType: 'video/mp4',
    });

    expect(stored.objectKey).toMatch(/^objects\/[0-9a-f]{64}\.data$/);
    expect(stored.objectKey).not.toContain('artifact-1');
    expect(stored.byteSize).toBe(bytes.byteLength);
    expect(stored.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(await store.metadata('artifact-1')).toEqual(stored);
    expect(await store.exists('artifact-1')).toBe(true);
    expect(await store.read('artifact-1')).toEqual(bytes);

    const stream = await store.open('artifact-1');
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    expect(
      new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
    ).toEqual(bytes);
    expect(
      (await readdir(join(root, 'objects'))).every(
        (name) => !name.startsWith('.tmp-'),
      ),
    ).toBe(true);
  });

  it('supports streamed and positional writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h3-artifact-stream-test-'));
    roots.push(root);
    const store = createLocalArtifactStore(root);
    async function* body(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    }

    const first = await store.put(
      'streamed',
      body(),
      'application/octet-stream',
    );
    const second = await store.put(
      'positional',
      new Uint8Array([5]),
      'application/octet-stream',
    );
    expect(await store.read(first.artifactId)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(second.byteSize).toBe(1);
  });

  it('rejects traversal-shaped identifiers and invalid MIME types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h3-artifact-validation-test-'));
    roots.push(root);
    const store = createLocalArtifactStore(root);
    for (const artifactId of [
      '',
      '.',
      '..',
      '../escape',
      'nested/name',
      'nested\\name',
    ]) {
      await expect(
        store.put({
          artifactId,
          body: new Uint8Array([1]),
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(/path traversal/i);
    }
    await expect(
      store.put({
        artifactId: 'bad-mime',
        body: new Uint8Array([1]),
        mimeType: 'video',
      }),
    ).rejects.toThrow(/MIME type/i);
  });

  it('removes only the requested object during test cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h3-artifact-cleanup-test-'));
    roots.push(root);
    const store = createLocalArtifactStore(root);
    await store.put('keep', new Uint8Array([1]), 'application/octet-stream');
    await store.put('remove', new Uint8Array([2]), 'application/octet-stream');

    await store.deleteForTestCleanup('remove');
    expect(await store.exists('remove')).toBe(false);
    expect(await store.exists('keep')).toBe(true);
    expect(await store.metadata('remove')).toBeNull();
  });
});
