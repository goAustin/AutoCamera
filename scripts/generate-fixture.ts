import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outputPath = resolve(
  process.argv[2] ?? '.data/fixtures/h3-t2v-fixture.mp4',
);
const temporaryPath = `${outputPath}.tmp-${process.pid}`;

async function main(): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const existing = await stat(outputPath);
    if (existing.isFile() && existing.size > 0) {
      console.log(`Synthetic media fixture already exists: ${outputPath}`);
      return;
    }
  } catch {
    // Generate the fixture when the destination does not exist.
  }

  const video = 'testsrc2=size=960x544:rate=24:duration=5,format=yuv420p';
  const audio = 'sine=frequency=440:sample_rate=32000:duration=5';
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      video,
      '-f',
      'lavfi',
      '-i',
      audio,
      '-ac',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      temporaryPath,
    ]);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    const detail =
      error instanceof Error ? error.message : 'unknown ffmpeg error';
    throw new Error(
      `Could not generate the synthetic MP4 with ffmpeg. Install ffmpeg and retry: ${detail}`,
    );
  }
  console.log(`Generated deterministic synthetic media fixture: ${outputPath}`);
}

await main();
