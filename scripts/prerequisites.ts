import { statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

const REQUIRED_NODE_MAJOR = 24;
const PINNED_PNPM_VERSION = '9.15.0';
const MINIMUM_FREE_BYTES = 10 * 1024 ** 3;

/**
 * `blocking` means the stack cannot start, or starts and is silently broken,
 * without it. `advisory` means it is worth knowing and is not a reason to
 * refuse to launch: a short disk fills up slowly and says so, and a port this
 * audit calls occupied is most often the previous run of this same stack --
 * where the server's own EADDRINUSE is a better message than a pre-emptive
 * refusal from a checker that cannot see whose process it is.
 */
type Severity = 'blocking' | 'advisory';

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly action: string;
  readonly severity: Severity;
}

interface CommandResult {
  readonly ok: boolean;
  readonly version: string;
}

function runVersionCommand(
  command: string,
  args: readonly string[],
): CommandResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { ok: false, version: '' };
  }

  const output = String(result.stdout ?? '').trim();
  return { ok: true, version: output.split('\n')[0] ?? '' };
}

function parseConfiguredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : fallback;
}

type PortState = 'free' | 'occupied' | 'postgres' | 'unknown';

function inspectPort(port: number): 'free' | 'occupied' | 'unknown' {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });

  if (result.error) {
    return 'unknown';
  }
  if (result.status === 0) {
    return 'occupied';
  }
  if (result.status === 1) {
    return 'free';
  }
  return 'unknown';
}

function inspectPostgresListener(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const timeout = setTimeout(() => finish(false), 1_000);

    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(reachable);
    };

    socket.once('connect', () => {
      const parameters = Buffer.from(
        'user\0h3_videoops\0database\0h3_videoops\0\0',
        'utf8',
      );
      const startup = Buffer.alloc(8 + parameters.length);
      startup.writeInt32BE(startup.length, 0);
      startup.writeInt32BE(196_608, 4);
      parameters.copy(startup, 8);
      socket.write(startup);
    });
    socket.once('data', (data) => {
      // PostgreSQL answers a valid startup packet with an authentication (R)
      // or error (E) message. Either response proves the listener is a
      // PostgreSQL service or tunnel; credentials are checked by db:migrate.
      finish(data[0] === 0x52 || data[0] === 0x45);
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

async function inspectConfiguredPort(
  name: string,
  port: number,
): Promise<PortState> {
  const state = inspectPort(port);
  if (state !== 'occupied' || name !== 'POSTGRES_PORT') {
    return state;
  }
  return (await inspectPostgresListener(port)) ? 'postgres' : 'occupied';
}

function inspectCompose(): CheckResult {
  const dockerCompose = runVersionCommand('docker', ['compose', 'version']);
  if (dockerCompose.ok) {
    const dockerRuntime = runVersionCommand('docker', ['info']);
    if (dockerRuntime.ok) {
      return {
        name: 'Compose-compatible runtime',
        ok: true,
        detail: `Docker Compose ${dockerCompose.version}`,
        action: '',
        severity: 'blocking',
      };
    }
  }

  const podmanCompose = runVersionCommand('podman', ['compose', 'version']);
  if (podmanCompose.ok) {
    return {
      name: 'Compose-compatible runtime',
      ok: true,
      detail: `Podman Compose ${podmanCompose.version}`,
      action: '',
      severity: 'blocking',
    };
  }

  return {
    name: 'Compose-compatible runtime',
    ok: false,
    detail:
      'Docker Compose, Podman Compose, and an active container runtime were not detected',
    action: 'Install/start Docker Desktop: brew install --cask docker',
    severity: 'blocking',
  };
}

async function audit(): Promise<CheckResult[]> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeCheck: CheckResult = {
    severity: 'blocking',
    name: 'Node.js 24 LTS',
    ok: nodeMajor === REQUIRED_NODE_MAJOR,
    detail: `found Node.js ${process.versions.node}`,
    action: 'Install/select Node 24: nvm install 24 && nvm use 24',
  };

  const corepack = runVersionCommand('corepack', ['--version']);
  const corepackCheck: CheckResult = {
    severity: 'advisory',
    name: 'Corepack',
    ok: corepack.ok,
    detail: corepack.ok
      ? `found Corepack ${corepack.version}`
      : 'Corepack was not detected',
    action: 'Enable it after selecting Node 24: corepack enable',
  };

  const pnpm = runVersionCommand('pnpm', ['--version']);
  const pnpmCheck: CheckResult = {
    severity: 'advisory',
    name: `pnpm ${PINNED_PNPM_VERSION}`,
    ok: pnpm.ok && pnpm.version === PINNED_PNPM_VERSION,
    detail: pnpm.ok ? `found pnpm ${pnpm.version}` : 'pnpm was not detected',
    action: `Activate the pinned version: corepack prepare pnpm@${PINNED_PNPM_VERSION} --activate`,
  };

  const ffmpeg = runVersionCommand('ffmpeg', ['-version']);
  const ffmpegCheck: CheckResult = {
    severity: 'blocking',
    name: 'ffmpeg',
    ok: ffmpeg.ok,
    detail: ffmpeg.ok ? `found ${ffmpeg.version}` : 'ffmpeg was not detected',
    action: 'Install it: brew install ffmpeg',
  };

  const ffprobe = runVersionCommand('ffprobe', ['-version']);
  const ffprobeCheck: CheckResult = {
    severity: 'blocking',
    name: 'ffprobe',
    ok: ffprobe.ok,
    detail: ffprobe.ok
      ? `found ${ffprobe.version}`
      : 'ffprobe was not detected',
    action: 'Install both media tools: brew install ffmpeg',
  };

  const filesystem = statfsSync(process.cwd());
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const diskCheck: CheckResult = {
    severity: 'advisory',
    name: 'Free disk space',
    ok: availableBytes >= MINIMUM_FREE_BYTES,
    detail: `${(availableBytes / 1024 ** 3).toFixed(1)} GiB available`,
    action: 'Free at least 10 GiB for dependencies, containers, and fixtures',
  };

  const comfyMode = process.env.COMFY_MODE ?? 'fake';
  const portEntries = [
    ['API_PORT', parseConfiguredPort('API_PORT', 3000)],
    ['WEB_PORT', parseConfiguredPort('WEB_PORT', 5173)],
    ...(comfyMode === 'fake'
      ? [
          [
            'FAKE_COMFY_PORT',
            parseConfiguredPort('FAKE_COMFY_PORT', 8188),
          ] as const,
        ]
      : []),
    ['POSTGRES_PORT', parseConfiguredPort('POSTGRES_PORT', 5432)],
  ] as const;
  const portChecks = await Promise.all(
    portEntries.map(async ([name, port]) => {
      const state = await inspectConfiguredPort(name, port);
      return {
        name: `Port ${name} (${port})`,
        ok: state === 'free' || state === 'postgres',
        detail:
          state === 'free'
            ? 'free'
            : state === 'postgres'
              ? 'an existing PostgreSQL service or tunnel is reachable'
              : state === 'occupied'
                ? 'occupied by another process'
                : 'could not be inspected',
        action:
          state === 'postgres'
            ? 'Keep the existing PostgreSQL service or tunnel and skip starting a second one'
            : 'Stop the process using this port or set a different local port',
        severity: 'advisory',
      } satisfies CheckResult;
    }),
  );

  return [
    nodeCheck,
    corepackCheck,
    pnpmCheck,
    inspectCompose(),
    ffmpegCheck,
    ffprobeCheck,
    diskCheck,
    ...portChecks,
  ];
}

// Two modes, one list of checks. Run directly -- `pnpm prerequisites` -- this
// is the thorough audit to run once before deploying, and every failure is a
// failure. Run from `pnpm dev` (which sets the environment variable below),
// only a blocking failure stops the launch; the rest are printed and the stack
// comes up anyway. A newcomer who cloned the repository should not be refused a
// running system because a checker noticed 9.2 GiB free instead of 10.
const advisoryMode =
  process.argv.includes('--advisory') ||
  process.env.H3_PREREQUISITES_MODE === 'advisory';

const checks = await audit();
console.log('H3 VideoOps prerequisite audit');

for (const check of checks) {
  const label = check.ok
    ? 'PASS'
    : advisoryMode && check.severity === 'advisory'
      ? 'WARN'
      : 'FAIL';
  console.log(`${label} ${check.name}: ${check.detail}`);
  if (!check.ok) {
    console.log(`      Action: ${check.action}`);
  }
}

const failures = checks.filter((check) => !check.ok);
const blocking = advisoryMode
  ? failures.filter((check) => check.severity === 'blocking')
  : failures;

if (blocking.length > 0) {
  console.log(`Result: BLOCKED — ${blocking.length} prerequisite(s) missing.`);
  process.exitCode = 1;
} else if (failures.length > 0) {
  console.log(
    `Result: READY with ${failures.length} warning(s) — nothing that stops the stack starting.`,
  );
} else {
  console.log('Result: READY — all local prerequisites are available.');
}
