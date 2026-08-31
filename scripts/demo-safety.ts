import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function redactedDatabaseTarget(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  return (
    parsed.protocol +
    '//' +
    parsed.hostname +
    ':' +
    (parsed.port || '5432') +
    parsed.pathname
  );
}

export function assertDevelopmentDatabase(databaseUrl: string): void {
  if (/[~$]/.test(databaseUrl)) {
    throw new Error(
      'Reset refused: DATABASE_URL contains an unresolved token.',
    );
  }
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Reset refused: DATABASE_URL is not PostgreSQL.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(
      'Reset refused: only a local development PostgreSQL target is allowed.',
    );
  }
}

export function assertSafeArtifactRoot(rawRoot: string): string {
  if (!rawRoot.trim() || /[~$]/.test(rawRoot)) {
    throw new Error('Reset refused: ARTIFACT_ROOT is empty or unresolved.');
  }
  const root = resolve(rawRoot);
  const workspace = resolve(process.cwd());
  const home = resolve(homedir());
  if (
    root === sep ||
    root === home ||
    root === workspace ||
    !isAbsolute(root) ||
    relative(workspace, root).startsWith(`..${sep}`) ||
    relative(workspace, root) === '..'
  ) {
    throw new Error(
      'Reset refused: ARTIFACT_ROOT must be a non-root directory inside the workspace.',
    );
  }
  return root;
}

export function artifactPath(root: string, objectKey: string): string {
  if (
    !objectKey ||
    objectKey.includes('\\') ||
    isAbsolute(objectKey) ||
    objectKey.split('/').some((part) => part === '..')
  ) {
    throw new Error('Reset refused: an artifact object key is unsafe.');
  }
  const candidate = resolve(root, objectKey);
  const rootRelative = relative(root, candidate);
  if (rootRelative === '' || rootRelative.startsWith(`..${sep}`)) {
    throw new Error('Reset refused: an artifact object escapes ARTIFACT_ROOT.');
  }
  return candidate;
}
