// `foedrum serve` shows that it is alive between its passes (#873), through runServe. The shell of
// serve.test.ts over a clock that only the waits move: an hour of an idle Cellar costs no real
// time. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

const MINUTE = 60_000;

describe('runServe', () => {
  const f = serveFixture();

  /** Serves for `minutes` of a clock the waits move; each line printed, with the ms since the start. */
  const servedFor = async (minutes: number) => {
    let now = t0.getTime();
    const stamped: { at: number; line: string }[] = [];
    const shell = f.shell({
      clock: () => new Date(now),
      wait: async (ms) => {
        now += ms;
        if (now - t0.getTime() > minutes * MINUTE) f.controller.abort();
      },
      out: (line) => {
        stamped.push({ at: now - t0.getTime(), line });
      },
    });
    const code = await runServe(f.setup, shell);
    return { code, stamped };
  };

  describe('once its work is done and it only waits (#873)', () => {
    // The one order is brewed, on tap and cleaned in the first minutes; what comes after is idle.
    const idle = (stamped: readonly { at: number; line: string }[], from: number, to: number) =>
      stamped.filter(({ at }) => at >= from * MINUTE && at < to * MINUTE);

    it('prints a line in every ten minutes, so a person can tell it is working, and at most one every half minute, so it does not fill the terminal', async () => {
      const { code, stamped } = await servedFor(40);
      assert.equal(code, 0, stamped.map(({ line }) => line).join('\n'));
      // A tick comes every 5 s: a line at each would be 120 in ten minutes.
      for (const [from, to] of [
        [10, 20],
        [20, 30],
        [30, 40],
      ] as const) {
        const lines = idle(stamped, from, to);
        assert.ok(
          lines.length >= 1 && lines.length <= 20,
          `${lines.length} lines from minute ${from} to ${to}:\n${stamped.map(({ at, line }) => `${at / 1000}s ${line}`).join('\n')}`,
        );
      }
    });

    it('says it still runs each 60 s of quiet, to within a tick, and no sooner: regression test', async () => {
      const { stamped } = await servedFor(12);
      const times = idle(stamped, 5, 12)
        .filter(({ line }) => line.includes('still running'))
        .map(({ at }) => at);
      assert.ok(times.length >= 2, stamped.map(({ line }) => line).join('\n'));
      times.slice(1).forEach((at, n) => {
        const gap = at - (times[n] ?? 0);
        assert.ok(gap >= MINUTE && gap <= MINUTE + 5_000, `${gap} ms apart`);
      });
    });

    it('counts its quiet from its last line of any kind: regression test', async () => {
      const { stamped } = await servedFor(12);
      const firstAlive = stamped.findIndex(({ line }) => line.includes('still running'));
      assert.ok(firstAlive > 0, stamped.map(({ line }) => line).join('\n'));
      const before = stamped[firstAlive - 1]?.at ?? 0;
      const gap = (stamped[firstAlive]?.at ?? 0) - before;
      assert.ok(gap >= MINUTE && gap <= MINUTE + 5_000, `${gap} ms after its last line`);
    });

    it('prints those lines as the rest of its lines: foedrum serve, a colon and the words', async () => {
      const { stamped } = await servedFor(12);
      const lines = idle(stamped, 10, 12);
      assert.ok(lines.length > 0, 'it printed lines when idle');
      for (const { line } of lines) assert.match(line, /^foedrum serve: \S/);
    });
  });

  it('says it still runs, and not that it brews, while nothing brews', async () => {
    const { stamped } = await servedFor(12);
    const alive = stamped.filter(({ at, line }) => at >= 10 * MINUTE && line.includes('still'));
    assert.ok(alive.length > 0, stamped.map(({ line }) => line).join('\n'));
    for (const { line } of alive) {
      assert.equal(line, 'foedrum serve: still running for Acme/Brewery');
    }
  });

  it('still opens with its brewing line and ends with its stopped line: regression test', async () => {
    const { code, stamped } = await servedFor(12);
    assert.equal(code, 0);
    const lines = stamped.map(({ line }) => line);
    assert.match(
      lines[0] ?? '',
      /^foedrum serve: brewing for Acme\/Brewery in .+; Ctrl\+C stops it$/,
    );
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
  });
});
