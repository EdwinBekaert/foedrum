// The order of serve's lasting lines within a tick (ADR 0434): the cleanup of a batch that ended in
// the tick follows the lines of the work it cleans. serve's shell of serve.test.ts over a virtual
// clock, with a runner that ends each attempt itself; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';
import { virtualTimeline } from '../helpers/virtual-timeline.ts';

const brewed: BrewerRunner = {
  start: () => ({
    ended: Promise.resolve({
      ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed', assumptions: [] } },
    }),
    stop: () => {},
  }),
  progress: () => undefined,
};

describe('runServe, the order of a tick’s lines (ADR 0434)', () => {
  const f = serveFixture();

  it('prints the cleanup of a batch after the lines of its step and its pull request', async () => {
    const timeline = virtualTimeline(t0, 60_000);
    const shell = f.shell({
      clock: timeline.clock,
      wait: timeline.wait,
      signal: timeline.controller.signal,
      out: (line) => f.lines.push(line),
      runner: () => brewed,
      worktrees: async () => ({
        ...fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') }),
        clean: async () => ({ done: ['removed worktree 12-1/brew/1'], kept: [], failed: [] }),
      }),
    });
    assert.equal(await runServe(f.setup, shell), 0, f.lines.join('\n'));
    const at = (needle: string) => f.lines.findIndex((line) => line.includes(needle));
    const step = at('#12 brew #1 succeeded');
    const opened = at('#12 opened pull request https://');
    const cleaned = at('cleaned its 1 working copy');
    assert.ok(step >= 0 && opened >= 0 && cleaned >= 0, f.lines.join('\n'));
    assert.ok(step < cleaned && opened < cleaned, f.lines.join('\n'));
  });
});
