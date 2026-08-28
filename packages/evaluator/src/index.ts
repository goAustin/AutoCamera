import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type MediaEvaluationStatus = 'not-run' | 'passed' | 'failed';

export interface MediaEvaluationPlaceholder {
  readonly status: MediaEvaluationStatus;
  readonly reason: string;
}

export const PHASE_1_EVALUATION_PLACEHOLDER: MediaEvaluationPlaceholder = {
  status: 'not-run',
  reason: 'Media evaluation is introduced after bootstrap.',
};

export interface ProcessRunOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = (): void => {
        child.kill('SIGKILL');
        finish({ exitCode: -1, stdout, stderr, timedOut: true });
      };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ exitCode: -1, stdout, stderr, timedOut: true });
      }, options.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        finish({
          exitCode: -1,
          stdout,
          stderr: `${stderr}${error instanceof Error ? error.message : ''}`,
        });
      });
      child.once('exit', (code) => {
        finish({ exitCode: code ?? -1, stdout, stderr });
      });
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

export interface ArtifactEvaluationMetadata {
  readonly byteSize: number;
  readonly sha256: string;
}

export interface MediaEvaluationInput {
  readonly bytes: Uint8Array;
  readonly artifact: ArtifactEvaluationMetadata;
  readonly expectedWidth?: number;
  readonly expectedHeight?: number;
  readonly expectedDurationSeconds?: number;
  readonly durationToleranceSeconds?: number;
  readonly expectedFrameRate?: number;
  readonly timeoutMs?: number;
}

export interface EvaluationCheck {
  readonly status: 'passed' | 'failed' | 'not_applicable';
  readonly detail: string;
}

export interface MediaEvaluation {
  readonly evaluatorVersion: string;
  readonly status: 'passed' | 'failed';
  readonly checks: Readonly<Record<string, EvaluationCheck>>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly failureCode?: string;
}

interface ProbeStream {
  readonly codec_type?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly duration?: unknown;
  readonly r_frame_rate?: unknown;
  readonly channels?: unknown;
  readonly sample_rate?: unknown;
}

interface ProbeResult {
  readonly format?: {
    readonly format_name?: unknown;
    readonly duration?: unknown;
  };
  readonly streams?: readonly ProbeStream[];
}

const DEFAULT_EVALUATOR_VERSION = 'phase-3-v1';

function pass(detail: string): EvaluationCheck {
  return { status: 'passed', detail };
}

function fail(detail: string): EvaluationCheck {
  return { status: 'failed', detail };
}

function notApplicable(detail: string): EvaluationCheck {
  return { status: 'not_applicable', detail };
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function frameRate(value: unknown): number | undefined {
  if (typeof value === 'number') return numberValue(value);
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(value);
  if (match) {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    return denominator ? numerator / denominator : undefined;
  }
  return numberValue(value);
}

function hasMotionEvidence(output: ProcessResult): boolean {
  const text = `${output.stdout}\n${output.stderr}`.toLowerCase();
  const blackDuration = /black_duration\s*[:=]\s*([\d.]+)/.exec(text)?.[1];
  const freezeDuration = /freeze_duration\s*[:=]\s*([\d.]+)/.exec(text)?.[1];
  if (blackDuration && Number(blackDuration) > 0) return false;
  if (freezeDuration && Number(freezeDuration) > 0) return false;
  if (/all-black|static|freeze_detected/.test(text)) return false;
  return true;
}

function firstFailureCode(
  checks: Readonly<Record<string, EvaluationCheck>>,
): string | undefined {
  const failures: ReadonlyArray<[string, string]> = [
    ['file_readable', 'MEDIA_NOT_FOUND'],
    ['checksum', 'MEDIA_CHECKSUM_MISMATCH'],
    ['byte_size', 'MEDIA_SIZE_MISMATCH'],
    ['container', 'MEDIA_INVALID_CONTAINER'],
    ['video_stream', 'MEDIA_MISSING_VIDEO'],
    ['dimensions', 'MEDIA_INVALID_DIMENSIONS'],
    ['duration', 'MEDIA_INVALID_DURATION'],
    ['frame_rate', 'MEDIA_INVALID_FRAME_RATE'],
    ['decoder', 'MEDIA_DECODE_FAILED'],
    ['motion', 'MEDIA_BLACK_OR_STATIC'],
  ];
  for (const [name, code] of failures) {
    if (checks[name]?.status === 'failed') return code;
  }
  return undefined;
}

export class MediaEvaluator {
  readonly evaluatorVersion: string;
  private readonly process: ProcessRunner;

  constructor(
    processRunner: ProcessRunner = new NodeProcessRunner(),
    evaluatorVersion = DEFAULT_EVALUATOR_VERSION,
  ) {
    this.process = processRunner;
    this.evaluatorVersion = evaluatorVersion;
  }

  async evaluate(input: MediaEvaluationInput): Promise<MediaEvaluation> {
    const expectedWidth = input.expectedWidth ?? 960;
    const expectedHeight = input.expectedHeight ?? 544;
    const expectedDuration = input.expectedDurationSeconds ?? 5;
    const tolerance = input.durationToleranceSeconds ?? 0.25;
    const expectedFps = input.expectedFrameRate ?? 24;
    const timeoutMs = input.timeoutMs ?? 10_000;
    const checks: Record<string, EvaluationCheck> = {};
    const actualSha256 = createHash('sha256').update(input.bytes).digest('hex');
    checks.file_readable =
      input.bytes.byteLength > 0
        ? pass(`${input.bytes.byteLength} bytes supplied`)
        : fail('Artifact is empty or unreadable.');
    checks.checksum =
      actualSha256 === input.artifact.sha256
        ? pass('SHA-256 matches artifact metadata.')
        : fail('SHA-256 does not match artifact metadata.');
    checks.byte_size =
      input.bytes.byteLength === input.artifact.byteSize
        ? pass('Byte size matches artifact metadata.')
        : fail('Byte size does not match artifact metadata.');

    const directory = await mkdtemp(join(tmpdir(), 'h3-media-'));
    const filePath = join(directory, 'artifact.mp4');
    let probe: ProbeResult | undefined;
    let decode: ProcessResult = { exitCode: -1, stdout: '', stderr: '' };
    let motion: ProcessResult = { exitCode: -1, stdout: '', stderr: '' };
    try {
      await writeFile(filePath, input.bytes);
      const probeResult = await this.process.run(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        { timeoutMs },
      );
      if (probeResult.exitCode === 0) {
        try {
          probe = JSON.parse(probeResult.stdout) as ProbeResult;
        } catch {
          probe = undefined;
        }
      }
      checks.container =
        probe?.format?.format_name &&
        /(?:^|,)(?:mp4|mov|m4v)(?:,|$)/.test(String(probe.format.format_name))
          ? pass(`Container ${String(probe.format.format_name)}.`)
          : fail('Expected an MP4-family container.');
      const streams = probe?.streams ?? [];
      const video = streams.find((stream) => stream.codec_type === 'video');
      const audio = streams.find((stream) => stream.codec_type === 'audio');
      checks.video_stream = video
        ? pass('Video stream is present.')
        : fail('Video stream is missing.');
      const actualWidth = numberValue(video?.width);
      const actualHeight = numberValue(video?.height);
      checks.dimensions =
        actualWidth === expectedWidth && actualHeight === expectedHeight
          ? pass(`${actualWidth}x${actualHeight}.`)
          : fail(
              `Expected ${expectedWidth}x${expectedHeight}; got ${actualWidth ?? 'unknown'}x${actualHeight ?? 'unknown'}.`,
            );
      const actualDuration = numberValue(
        video?.duration ?? probe?.format?.duration,
      );
      checks.duration =
        actualDuration !== undefined &&
        Math.abs(actualDuration - expectedDuration) <= tolerance
          ? pass(`${actualDuration.toFixed(3)} seconds.`)
          : fail(
              `Expected ${expectedDuration}±${tolerance} seconds; got ${actualDuration ?? 'unknown'}.`,
            );
      const actualFrameRate = frameRate(video?.r_frame_rate);
      checks.frame_rate =
        actualFrameRate !== undefined &&
        Math.abs(actualFrameRate - expectedFps) <= 0.5
          ? pass(`${actualFrameRate.toFixed(3)} fps.`)
          : fail(
              `Expected approximately ${expectedFps} fps; got ${actualFrameRate ?? 'unknown'}.`,
            );
      decode = await this.process.run(
        'ffmpeg',
        ['-v', 'error', '-i', filePath, '-f', 'null', '-'],
        { timeoutMs },
      );
      checks.decoder =
        decode.exitCode === 0 && !decode.timedOut
          ? pass('Decoder completed without errors.')
          : fail('Decoder did not complete successfully.');
      motion = await this.process.run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          filePath,
          '-vf',
          'blackdetect=d=0.1:pic_th=0.98,freezedetect=n=-60dB:d=0.5',
          '-f',
          'null',
          '-',
        ],
        { timeoutMs },
      );
      checks.motion =
        motion.exitCode === 0 && hasMotionEvidence(motion)
          ? pass('Motion/test-pattern evidence is present.')
          : fail('Output is fully black, static, or motion analysis failed.');
      if (audio) {
        const channels = numberValue(audio.channels);
        const sampleRate = numberValue(audio.sample_rate);
        checks.audio = pass(
          `Audio present: ${channels ?? 'unknown'} channels at ${sampleRate ?? 'unknown'} Hz.`,
        );
      } else {
        checks.audio = notApplicable(
          'No audio stream; audio is optional for the placeholder.',
        );
      }
      const details: Record<string, unknown> = {
        width: actualWidth,
        height: actualHeight,
        durationSeconds: actualDuration,
        frameRate: actualFrameRate,
        audioPresent: Boolean(audio),
        audioChannels: audio ? numberValue(audio.channels) : null,
        audioSampleRate: audio ? numberValue(audio.sample_rate) : null,
        byteSize: input.bytes.byteLength,
        sha256: actualSha256,
      };
      const failureCode = firstFailureCode(checks);
      return {
        evaluatorVersion: this.evaluatorVersion,
        status: failureCode ? 'failed' : 'passed',
        checks,
        details,
        ...(failureCode ? { failureCode } : {}),
      };
    } catch (error) {
      checks.container ??= fail('ffprobe could not inspect the artifact.');
      checks.decoder ??= fail(
        error instanceof Error ? error.message : 'ffmpeg failed.',
      );
      checks.motion ??= fail('Motion analysis did not run.');
      const failureCode = firstFailureCode(checks) ?? 'MEDIA_DECODE_FAILED';
      return {
        evaluatorVersion: this.evaluatorVersion,
        status: 'failed',
        checks,
        details: {
          byteSize: input.bytes.byteLength,
          sha256: actualSha256,
        },
        failureCode,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class DeterministicFixtureProcessRunner implements ProcessRunner {
  readonly failCheck: string | undefined;

  constructor(options: { readonly failCheck?: string } = {}) {
    this.failCheck = options.failCheck;
  }

  async run(
    command: string,
    args: readonly string[],
    _options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    if (this.failCheck === 'ffprobe' && command === 'ffprobe') {
      return { exitCode: 1, stdout: '', stderr: 'fixture ffprobe failure' };
    }
    if (
      this.failCheck === 'decoder' &&
      command === 'ffmpeg' &&
      args.includes('-f')
    ) {
      return { exitCode: 1, stdout: '', stderr: 'fixture decoder failure' };
    }
    if (
      this.failCheck === 'motion' &&
      command === 'ffmpeg' &&
      args.includes('-vf')
    ) {
      return { exitCode: 0, stdout: 'freeze_duration: 5', stderr: '' };
    }
    if (command === 'ffprobe') {
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5.000' },
          streams: [
            {
              codec_type: 'video',
              width: 960,
              height: 544,
              duration: '5.000',
              r_frame_rate: '24/1',
            },
            { codec_type: 'audio', channels: 2, sample_rate: '32000' },
          ],
        }),
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}
