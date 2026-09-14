import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

interface ManagedProcess {
  readonly label: string;
  readonly child: ChildProcess;
  readonly exited: Promise<number>;
}

/**
 * A clone has no `.env`, and without one the first thing a newcomer sees is
 * `Invalid or missing environment variables: DEV_AUTH_TOKEN` from a service
 * that has already started booting. The example file is the answer every time
 * -- it is a complete local configuration, not a template with blanks -- so
 * copy it rather than asking someone to. An existing `.env` is never touched.
 */
function ensureLocalEnvironment(): void {
  const envPath = `${process.cwd()}/.env`;
  const examplePath = `${process.cwd()}/.env.example`;
  if (existsSync(envPath) || !existsSync(examplePath)) {
    return;
  }
  copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example (local development defaults).');
}

function loadLocalEnvironment(): void {
  const envPath = `${process.cwd()}/.env`;
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }

    const [, name, rawValue] = match;
    if (!name || rawValue === undefined || process.env[name] !== undefined) {
      continue;
    }

    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    process.env[name] = value;
  }
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${signal ?? `code ${code ?? 'unknown'}`}`,
        ),
      );
    });
  });
}

function startManaged(label: string, args: readonly string[]): ManagedProcess {
  const child = spawn('pnpm', [...args], {
    env: process.env,
    stdio: 'inherit',
  });
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
  return { label, child, exited };
}

ensureLocalEnvironment();
loadLocalEnvironment();

// Both of these default to cwd-relative paths, and every child below runs with
// its own package directory as cwd because `pnpm --filter` puts it there. The
// fake executor's fixture lookup then misses and falls back -- silently, in a
// `catch {}` -- to a 184-byte synthetic stub, so every managed run in `pnpm dev`
// failed evaluation with MEDIA_INVALID_CONTAINER while the browser suite passed,
// because playwright.config.ts has always pinned these absolutely. Artifacts
// landed under `apps/api/.data/` for the same reason. `resolve` is a no-op on a
// value that is already absolute, so an explicit setting still wins.
const repositoryRoot = process.cwd();
process.env.H3_MEDIA_FIXTURE_PATH = resolve(
  repositoryRoot,
  process.env.H3_MEDIA_FIXTURE_PATH ?? '.data/fixtures/h3-t2v-fixture.mp4',
);
process.env.ARTIFACT_ROOT = resolve(
  repositoryRoot,
  process.env.ARTIFACT_ROOT ?? '.data/artifacts',
);

try {
  const comfyMode = process.env.COMFY_MODE ?? 'fake';
  if (comfyMode !== 'fake' && comfyMode !== 'remote') {
    throw new Error('COMFY_MODE must be either fake or remote.');
  }

  // Advisory: a blocking prerequisite still stops the launch, but a warning --
  // a short disk, a port this checker thinks is occupied -- does not. Run
  // `pnpm prerequisites` directly for the strict audit before a deployment.
  process.env.H3_PREREQUISITES_MODE ??= 'advisory';
  await run('pnpm', ['prerequisites']);
  await run('pnpm', ['media:fixture']);
  await run('pnpm', ['infra:up']);
  await run('pnpm', ['db:migrate']);
  await run('pnpm', ['build']);

  const apiPort = process.env.API_PORT ?? '3000';
  const apiHost = process.env.API_HOST ?? '127.0.0.1';
  process.env.VITE_API_ORIGIN ??= `http://${apiHost}:${apiPort}`;
  const children = [
    startManaged('api', ['--filter', '@h3/api', 'dev']),
    ...(comfyMode === 'fake'
      ? [startManaged('fake-comfy', ['--filter', '@h3/fake-comfy', 'dev'])]
      : []),
    startManaged('web', ['--filter', '@h3/web', 'dev']),
  ];

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Stopping local stack (${reason}).`);
    for (const managed of children) {
      managed.child.kill('SIGTERM');
    }
    await Promise.all(children.map((managed) => managed.exited));
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  const firstExit = await Promise.race(
    children.map(async (managed) => ({
      label: managed.label,
      code: await managed.exited,
    })),
  );
  if (!shuttingDown) {
    await shutdown(
      `${firstExit.label} exited with code ${firstExit.code}`,
      firstExit.code,
    );
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Development stack failed to start.',
  );
  process.exitCode = 1;
}
