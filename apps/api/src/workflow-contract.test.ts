import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectNodeErrors, loadPinnedObjectInfo } from '@h3/comfy-client';
import {
  compileWorkflow,
  FIXTURE_MANIFEST,
  FIXTURE_WORKFLOW,
  loadFixtureFiles,
} from '@h3/workflow-compiler';

// This lives in `apps/api` rather than beside the compiler because it is a
// claim about two packages at once -- what `@h3/workflow-compiler` emits, and
// what `@h3/comfy-client` says the pinned executor accepts. The API is where
// those meet in production: it compiles the graph and the worker submits it.
//
// The hole this file closes: nothing offline ever submitted the compiled
// fixture to the rule the fake executor enforces. The compiler's own tests
// check shape and bindings, the browser suite is the only thing that submits,
// and so a fixture missing eight of `KSampler`'s required inputs shipped and
// failed every non-managed attempt with COMFY_UNAVAILABLE. Checking it here
// costs milliseconds and no GPU.

const input = {
  prompt: 'A silver device crossing a moving blue set.',
  width: 960,
  height: 544,
  durationSeconds: 5,
  seed: 1234,
  steps: 12,
};

describe('the offline fixture against the pinned executor contract', () => {
  it('compiles to a graph the pinned object_info accepts', () => {
    const compiled = compileWorkflow(input);
    expect(
      collectNodeErrors(loadPinnedObjectInfo(), compiled.workflow),
    ).toEqual({});
  });

  it('would notice a required input going missing', () => {
    // Proof the assertion above has teeth rather than passing vacuously: the
    // exact defect that shipped -- a required input absent from a node -- must
    // be reported, and reported against the node it belongs to.
    const compiled = compileWorkflow(input);
    const damaged = structuredClone(compiled.workflow) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const node = damaged['127'];
    if (!node) throw new Error('expected the UNETLoader node to exist');
    delete node.inputs.weight_dtype;

    const errors = collectNodeErrors(loadPinnedObjectInfo(), damaged);
    expect(Object.keys(errors)).toEqual(['127']);
    expect(JSON.stringify(errors)).toContain('required_input_missing');
  });

  it('is the graph this project ships, not a second copy of it', async () => {
    // `FIXTURE_WORKFLOW` is a literal so this module stays a pure constant.
    // That is only safe while something forces the two to move together --
    // the same bargain `packages/comfy-client` makes with the pinned
    // capability fingerprint.
    const shippedPath = fileURLToPath(
      new URL('../../../workflows/minimax-h3/api.json', import.meta.url),
    );
    const shipped = JSON.parse(await readFile(shippedPath, 'utf8')) as unknown;
    expect(FIXTURE_WORKFLOW).toEqual(shipped);
  });

  it('keeps the on-disk manifest identical to the constant', async () => {
    const fixture = await loadFixtureFiles();
    expect(fixture.manifest).toEqual(FIXTURE_MANIFEST);
    expect(fixture.workflow).toEqual(FIXTURE_WORKFLOW);
  });
});
