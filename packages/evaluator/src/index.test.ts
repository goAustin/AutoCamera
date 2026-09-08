import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeterministicFixtureProcessRunner,
  MediaEvaluator,
  type ProcessResult,
  type ProcessRunOptions,
  type ProcessRunner,
} from './index.js';

const bytes = new TextEncoder().encode('synthetic evaluator fixture bytes');
const artifact = {
  byteSize: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

class CapturingRunner implements ProcessRunner {
  readonly calls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: ProcessRunOptions;
  }> = [];
  private readonly delegate = new DeterministicFixtureProcessRunner();

  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args], options });
    return this.delegate.run(command, args, options);
  }
}

interface ProbeOptions {
  readonly formatName?: string;
  readonly video?: Partial<{
    codec_type: string;
    width: number;
    height: number;
    duration: string;
    r_frame_rate: string;
  }>;
  readonly includeVideo?: boolean;
  readonly includeAudio?: boolean;
  readonly decoderExitCode?: number;
  readonly motionOutput?: string;
}

class ProbeRunner implements ProcessRunner {
  constructor(private readonly options: ProbeOptions = {}) {}

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    if (command === 'ffprobe') {
      const streams = [
        ...(this.options.includeVideo === false
          ? []
          : [
              {
                codec_type: 'video',
                width: this.options.video?.width ?? 960,
                height: this.options.video?.height ?? 544,
                duration: this.options.video?.duration ?? '5.000',
                r_frame_rate: this.options.video?.r_frame_rate ?? '24/1',
                ...this.options.video,
              },
            ]),
        ...(this.options.includeAudio === false
          ? []
          : [{ codec_type: 'audio', channels: 2, sample_rate: 32_000 }]),
      ];
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: {
            format_name: this.options.formatName ?? 'mov,mp4,m4a,3gp,3g2,mj2',
            duration: '5.000',
          },
          streams,
        }),
        stderr: '',
      };
    }
    if (args.includes('-vf')) {
      return {
        exitCode: 0,
        stdout: this.options.motionOutput ?? '',
        stderr: '',
      };
    }
    return {
      exitCode: this.options.decoderExitCode ?? 0,
      stdout: '',
      stderr: '',
    };
  }
}

function evaluate(
  runner: ProcessRunner,
  input: Partial<Parameters<MediaEvaluator['evaluate']>[0]> = {},
) {
  return new MediaEvaluator(runner).evaluate({
    bytes,
    artifact,
    ...input,
  });
}

interface FailureCase {
  readonly name: string;
  readonly runner?: ProcessRunner;
  readonly bytes?: Uint8Array;
  readonly artifact?: { readonly byteSize: number; readonly sha256: string };
}

const failureCases: readonly FailureCase[] = [
  {
    name: 'file_readable',
    bytes: new Uint8Array(),
    artifact: {
      byteSize: 0,
      sha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
    },
  },
  {
    name: 'checksum',
    artifact: { byteSize: bytes.byteLength, sha256: '0'.repeat(64) },
  },
  {
    name: 'byte_size',
    artifact: { byteSize: bytes.byteLength + 1, sha256: artifact.sha256 },
  },
  { name: 'container', runner: new ProbeRunner({ formatName: 'avi' }) },
  { name: 'video_stream', runner: new ProbeRunner({ includeVideo: false }) },
  { name: 'dimensions', runner: new ProbeRunner({ video: { width: 1280 } }) },
  { name: 'duration', runner: new ProbeRunner({ video: { duration: '4.0' } }) },
  {
    name: 'frame_rate',
    runner: new ProbeRunner({ video: { r_frame_rate: '30/1' } }),
  },
  { name: 'decoder', runner: new ProbeRunner({ decoderExitCode: 1 }) },
  {
    name: 'motion',
    runner: new ProbeRunner({ motionOutput: 'freeze_duration: 5' }),
  },
  // Verbatim ffmpeg output for an all-black clip. Before the probe ran at a
  // log level that surfaces it, this text never reached the evaluator and an
  // all-black artifact passed.
  {
    name: 'motion from real blackdetect output',
    runner: new ProbeRunner({
      motionOutput:
        '[Parsed_blackdetect_0 @ 0x600003290a50] black_start:0 black_end:2.958333 black_duration:2.958333',
    }),
  },
  // A freeze that runs to end-of-file reports a start and never a duration.
  {
    name: 'motion from a freeze that never ends',
    runner: new ProbeRunner({
      motionOutput:
        '[Parsed_freezedetect_1 @ 0x600003290b00] lavfi.freezedetect.freeze_start: 0',
    }),
  },
];

describe('deterministic media evaluator', () => {
  it('passes the fixture and records every technical check', async () => {
    const runner = new CapturingRunner();
    const result = await evaluate(runner);

    expect(result.status).toBe('passed');
    expect(result.evaluatorVersion).toBe('phase-3-v1');
    expect(
      Object.values(result.checks).every((check) => check.status !== 'failed'),
    ).toBe(true);
    expect(result.checks.audio?.detail).toContain('2 channels');
    expect(result.details).toMatchObject({
      width: 960,
      height: 544,
      durationSeconds: 5,
      frameRate: 24,
      audioPresent: true,
      audioChannels: 2,
      audioSampleRate: 32_000,
    });
    expect(runner.calls.map((call) => call.command)).toEqual([
      'ffprobe',
      'ffmpeg',
      'ffmpeg',
    ]);
    expect(
      runner.calls.every(
        (call) => Array.isArray(call.args) && call.options.timeoutMs === 10_000,
      ),
    ).toBe(true);
  });

  it('records the optional no-audio result without failing the fixture', async () => {
    const result = await evaluate(new ProbeRunner({ includeAudio: false }));
    expect(result.status).toBe('passed');
    expect(result.checks.audio?.status).toBe('not_applicable');
    expect(result.details.audioPresent).toBe(false);
  });

  it.each(failureCases)(
    'fails the $name check with a stable code',
    async (options) => {
      const result = await evaluate(
        options.runner ?? new DeterministicFixtureProcessRunner(),
        {
          ...(options.bytes ? { bytes: options.bytes } : {}),
          ...(options.artifact ? { artifact: options.artifact } : {}),
        },
      );
      expect(result.status).toBe('failed');
      expect(
        Object.values(result.checks).some((check) => check.status === 'failed'),
      ).toBe(true);
      expect(result.failureCode).toMatch(/^MEDIA_/);
    },
  );

  it('probes for motion at a log level that surfaces the detectors', async () => {
    const runner = new CapturingRunner();
    await evaluate(runner);

    const motion = runner.calls.find((call) => call.args.includes('-vf'));
    if (!motion) throw new Error('Expected a motion probe.');

    // `blackdetect` and `freezedetect` report at info level. At `-v error` they
    // emit nothing, `hasMotionEvidence` finds no duration to object to, and the
    // check passes for every input including an all-black one -- which is what
    // it did. The log level is the whole guard, so assert it directly.
    const level = motion.args[motion.args.indexOf('-v') + 1];
    expect(level).toBe('info');
    expect(motion.args).not.toContain('error');

    // The decoder probe is a different case: it is judged by exit code, so it
    // stays quiet.
    const decoder = runner.calls.find(
      (call) => call.command === 'ffmpeg' && !call.args.includes('-vf'),
    );
    if (!decoder) throw new Error('Expected a decoder probe.');
    expect(decoder.args[decoder.args.indexOf('-v') + 1]).toBe('error');
  });
});
