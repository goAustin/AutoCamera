import { resolve } from 'node:path';

// Published captures are regenerated only when explicitly asked for.
//
// These specs write the PNGs that are committed under `assets/screenshots/`
// and accounted for in `EVIDENCE-MANIFEST.md`. Writing them unconditionally
// meant an ordinary `pnpm test:e2e` rewrote published evidence as a side
// effect of running the tests -- and because the documentation gate checks
// only that each file exists and is cited, never what it contains, a degraded
// capture passed every check silently.
//
// Default output therefore goes to the ignored `test-results/` tree. Set
// `CAPTURE_EVIDENCE=1` to write into `assets/screenshots/` on purpose, which
// is what the capture commands recorded in the manifest do.
export const capturesEvidence = process.env.CAPTURE_EVIDENCE === '1';

export function screenshotRoot(subdirectory?: string): string {
  const base = resolve(
    process.cwd(),
    capturesEvidence ? 'assets/screenshots' : 'test-results/screenshots',
  );
  return subdirectory ? resolve(base, subdirectory) : base;
}
