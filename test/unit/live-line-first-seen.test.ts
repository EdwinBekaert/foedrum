// What the live line counts an attempt's time from (ADR 0427): the attempt itself, by its batch,
// step and number, not by its label, which the batches of a serve share.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLiveLine, type LiveBatch } from '../../src/cli/live-line.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';
import { t0 } from '../helpers/serve-fixture.ts';

/** A batch with its `brew #1` running, as the driver reports it. */
const batch = (batchId: string, running: boolean): LiveBatch => ({
  since: { words: 'ordered', from: t0.getTime() },
  running: running ? [{ label: 'brew #1', ref: { batchId, stepId: 'brew', attempt: 1 } }] : [],
  progressOf: () => undefined,
});

describe('createLiveLine', () => {
  describe('counts an attempt from when it first saw it run (ADR 0427)', () => {
    /** Draws the line once at `seconds` after t0, with the batches `held` then. */
    const drawnAt = async (seconds: number[], held: (at: number) => LiveBatch[]) => {
      const screen = fakeScreen(200);
      let now = t0.getTime();
      const controller = new AbortController();
      const line = createLiveLine({
        terminal: screen.terminal,
        signal: controller.signal,
        clock: () => new Date(now),
        wait: async () => {},
        batches: () => held(now),
      });
      for (const second of seconds) {
        now = t0.getTime() + second * 1000;
        await line.pause(1000);
      }
      return screen.rewrites().map((text) => text.slice(2));
    };

    it('counts the same label of two batches from each batch’s own start', async () => {
      // Batch 12-1 runs its brew #1 from the start; batch 13-1 starts its own 100 s later.
      const lines = await drawnAt([0, 100], (at) => [
        batch('12-1', true),
        batch('13-1', at > t0.getTime()),
      ]);
      assert.match(lines.at(-1) ?? '', /brew #1 \/ 1m 40s ; .*brew #1 \/ 0s$/);
    });

    it('forgets an attempt that no longer runs, so its number run again counts from its new start', async () => {
      // Batch 12-1 runs at 0 s, does not at 50 s, and runs again at 100 s.
      const lines = await drawnAt([0, 50, 100], (at) => [
        batch('12-1', at === t0.getTime() || at === t0.getTime() + 100_000),
      ]);
      assert.match(lines.at(-1) ?? '', /brew #1 \/ 0s$/);
    });
  });
});
