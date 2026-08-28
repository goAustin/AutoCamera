import { existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

interface ManagedProcess {
  readonly label: string;
  readonly child: ChildProcess;
  readonly exited: Promise<number>;
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

loadLocalEnvironment();

try {
  await run('pnpm', ['prerequisites']);
  await run('pnpm', ['infra:up']);
  await run('pnpm', ['db:migrate']);
  await run('pnpm', ['build']);

  const apiPort = process.env.API_PORT ?? '3000';
  const apiHost = process.env.API_HOST ?? '127.0.0.1';
  process.env.VITE_API_ORIGIN ??= `http://${apiHost}:${apiPort}`;
  const children = [
    startManaged('api', ['--filter', '@h3/api', 'dev']),
    startManaged('fake-comfy', ['--filter', '@h3/fake-comfy', 'dev']),
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
