import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactPath,
  assertDevelopmentDatabase,
  assertSafeArtifactRoot,
  redactedDatabaseTarget,
} from './demo-safety.ts';

describe('deterministic demo safety', () => {
  it('allows only a local PostgreSQL target and redacts credentials', () => {
    const target =
      'postgres://demo-user:private-password@127.0.0.1:5432/videoops';
    expect(redactedDatabaseTarget(target)).toBe(
      'postgres://127.0.0.1:5432/videoops',
    );
    expect(() => assertDevelopmentDatabase(target)).not.toThrow();
    expect(() =>
      assertDevelopmentDatabase('postgres://user:pass@remote.example/videoops'),
    ).toThrow(/local development/);
    expect(() =>
      assertDevelopmentDatabase('postgres://user:pass@$DATABASE_HOST/videoops'),
    ).toThrow(/unresolved/);
  });

  it('rejects broad or unresolved artifact targets', () => {
    expect(() => assertSafeArtifactRoot('')).toThrow(/empty/);
    expect(() => assertSafeArtifactRoot('$WORKSPACE/artifacts')).toThrow(
      /empty or unresolved/,
    );
    expect(() => assertSafeArtifactRoot('.')).toThrow(/non-root/);
    expect(() => assertSafeArtifactRoot(homedir())).toThrow(/non-root/);
    expect(() => assertSafeArtifactRoot('/')).toThrow(/non-root/);
    expect(assertSafeArtifactRoot('.data/demo-artifacts')).toBe(
      resolve(process.cwd(), '.data/demo-artifacts'),
    );
  });

  it('rejects artifact keys that escape the selected root', () => {
    const root = resolve(process.cwd(), '.data/demo-artifacts');
    expect(artifactPath(root, 'attempt-1/video.mp4')).toBe(
      resolve(root, 'attempt-1/video.mp4'),
    );
    expect(() => artifactPath(root, '')).toThrow(/unsafe/);
    expect(() => artifactPath(root, '../outside.mp4')).toThrow(/unsafe/);
    expect(() => artifactPath(root, '/tmp/outside.mp4')).toThrow(/unsafe/);
    expect(() => artifactPath(root, 'C:\\\\tmp\\\\outside.mp4')).toThrow(
      /unsafe/,
    );
  });
});
