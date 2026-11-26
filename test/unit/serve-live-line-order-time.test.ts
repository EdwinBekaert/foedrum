// What the time of a batch in `foedrum serve`'s live line counts from (ADR 0427, ADR 0179, #1172),
// through runServe over a fake screen and a virtual clock; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';
import { virtualTimeline } from '../helpers/virtual-timeline.ts';

describe('runServe', () => {
  const f = serveFixture();

  /** Serves for 30 s on a terminal, over a batch ordered with `at` or without it. */
  const served = async (at: boolean) => {
    f.store = { ...openSqliteEventStore(':memory:'), close: () => {} };
    f.store.withTransaction((tx) =>
      tx.append({
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: t0.toISOString(),
        ...(at ? { at: t0.toISOString() } : {}),
      }),
    );
    createCommandLog({ store: f.store, recipes: f.setup.recipes }).issue(
      { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label', source: 'label' },
      t0,
    );
    const screen = fakeScreen(120);
    const timeline = virtualTimeline(t0, 30_000);
    const runner = fakeBrewerRunner(() =>
      behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0, turn: 3 }),
    );
    const shell = f.shell({
      clock: timeline.clock,
      wait: timeline.wait,
      signal: timeline.controller.signal,
      out: (line) => {
        f.lines.push(line);
        screen.print(line);
      },
      terminal: screen.terminal,
      runner: () => runner,
    });
    assert.equal(await runServe(f.setup, shell), 0, f.lines.join('\n'));
    return screen.rewrites().filter((line) => line.includes('brew #1'));
  };

  describe('with a live line on a terminal (ADR 0427)', () => {
    it('counts the time of a batch from its order, and says ordered', async () => {
      const lines = await served(true);
      assert.ok(lines.length > 0, 'a live line is drawn');
      for (const line of lines) assert.match(line, /^[|/\\-] ordered \d+s ago \/ brew #1 \//);
    });

    it("counts the time of a batch that records no order from serve's start, and says so", async () => {
      const lines = await served(false);
      assert.ok(lines.length > 0, 'a live line is drawn');
      for (const line of lines) {
        assert.match(line, /^[|/\\-] serve started \d+s ago \/ brew #1 \//);
      }
    });
  });
});
