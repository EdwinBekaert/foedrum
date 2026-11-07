// The moving mark of `foedrum brew`'s live line (ADR 0346), through runBrew: a virtual clock and
// timers, a fake screen and a brewer that runs until the brew is stopped. No process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { BRAILLE_MARKS } from '../../src/cli/live-terminal.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import { brewFixture, idle, request, t0 } from '../helpers/brew-fixture.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';
import { virtualTimeline } from '../helpers/virtual-timeline.ts';

describe('runBrew', () => {
  const f = brewFixture();

  interface Marked {
    seconds: number;
    columns?: number;
    progress?: AttemptProgress;
  }

  /** Brews for `seconds` of a virtual clock with gh's marks on a fake screen. */
  const brewMarked = async ({ seconds, columns = 120, progress = idle }: Marked) => {
    const screen = fakeScreen(columns, BRAILLE_MARKS);
    const timeline = virtualTimeline(t0, seconds * 1000);
    let flushes = 0;
    let reads = 0;
    const own: number[] = [];
    const inner = fakeBrewerRunner(() => behave.hang(progress));
    const live: ServeShell = {
      ...f.shell(behave.succeed()),
      terminal: screen.terminal,
      out: (line) => {
        f.lines.push(line);
        screen.print(line);
      },
      signal: timeline.controller.signal,
      clock: timeline.clock,
      wait: (ms, signal) => {
        if (signal === timeline.controller.signal) own.push(ms);
        return timeline.wait(ms, signal);
      },
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => {
          flushes += 1;
          return { kind: 'unchanged' };
        },
      }),
      runner: () => ({
        ...inner,
        progress: (ref) => {
          reads += 1;
          return inner.progress(ref);
        },
      }),
    };
    const code = await runBrew(f.setup, live, request);
    return { code, screen, flushes: () => flushes, reads: () => reads, own };
  };

  describe('with the moving mark on its live line (ADR 0346)', () => {
    it('turns the mark through its frames in order, about eight times a second', async () => {
      const { screen } = await brewMarked({ seconds: 10 });
      const frames = screen.rewrites().map((drawn) => drawn.charAt(0));
      const turns = frames.filter((frame, n) => n > 0 && frame !== frames[n - 1]);
      // 120 ms a frame is 83 in ten seconds.
      assert.ok(turns.length >= 60 && turns.length <= 90, `${turns.length} turns in 10 s`);
      frames.forEach((frame, n) => {
        const before = frames[n - 1];
        if (before === undefined || before === frame) return;
        const next = BRAILLE_MARKS[(BRAILLE_MARKS.indexOf(before) + 1) % BRAILLE_MARKS.length];
        assert.equal(frame, next, `after ${before}`);
      });
    });

    it('keeps the rest of the line in ASCII, with a mark a model wrote escaped', async () => {
      const lastTool = { name: BRAILLE_MARKS[0] ?? '', word: 'src/a.ts' };
      const { screen } = await brewMarked({
        seconds: 5,
        progress: { ...idle, turn: 3, lastTool },
      });
      const attempt = screen.rewrites().filter((drawn) => drawn.includes('brew #1'));
      assert.ok(
        attempt.some((drawn) => drawn.includes('\\u28fe src/a.ts')),
        screen.rewrites().join('\n'),
      );
      for (const drawn of screen.rewrites()) {
        assert.ok(BRAILLE_MARKS.includes(drawn.charAt(0)), drawn);
        assert.match(drawn.slice(1), /^[ -~]*$/);
      }
    });

    it('counts the mark as one column in the cut to the width less one: regression test', async () => {
      const lastTool = { name: 'Edit', word: 'x'.repeat(300) };
      const { screen } = await brewMarked({
        seconds: 5,
        columns: 40,
        progress: { ...idle, turn: 3, lastTool },
      });
      const full = screen.rewrites().filter((drawn) => drawn.includes('brew #1'));
      assert.ok(full.length > 0, screen.rewrites().join('\n'));
      for (const drawn of full) assert.equal(drawn.length, 39, drawn);
    });

    it('leaves how often the driver ticks as it was, a flush each 5 s on waits of a second: regression test', async () => {
      const { flushes, own } = await brewMarked({ seconds: 30 });
      assert.ok(flushes() >= 5 && flushes() <= 9, `${flushes()} ticks in 30 s`);
      assert.ok(own.length > 0 && own.every((ms) => ms === 1000), own.join(' '));
    });

    it('reads what the attempts report once a second, not at each frame', async () => {
      const { reads, screen } = await brewMarked({ seconds: 30 });
      const drawn = screen.rewrites().length;
      assert.ok(drawn >= 150, `${drawn} lines drawn in 30 s`);
      assert.ok(reads() >= 25 && reads() <= 45, `${reads()} reads in 30 s`);
    });

    it('draws nothing more once the brew has ended, and leaves no line on screen', async () => {
      const { screen } = await brewMarked({ seconds: 5 });
      assert.ok(screen.rewrites().length > 40, `${screen.rewrites().length} lines drawn`);
      assert.equal(screen.drawn(), undefined);
      const events = screen.events.length;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(screen.events.length, events);
    });

    it('leaves no timer running when it is refused before it takes its lock: regression test', async () => {
      const screen = fakeScreen(120, BRAILLE_MARKS);
      const waits: number[] = [];
      const live: ServeShell = {
        ...f.shell(behave.succeed()),
        terminal: screen.terminal,
        wait: async (ms) => {
          waits.push(ms);
        },
      };
      const unknown = { ...request, target: { alias: 'nobody', issue: 7 } };
      assert.equal(await runBrew(f.setup, live, unknown), 5);
      assert.ok(
        f.lines.some((line) => line.includes('nobody')),
        f.lines.join('\n'),
      );
      for (let turn = 0; turn < 5; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(waits, []);
    });

    it('goes on brewing when a redraw beside a call fails', async () => {
      const screen = fakeScreen(120);
      const { rewrite } = screen.terminal;
      let draws = 0;
      const timeline = virtualTimeline(t0, 60_000);
      const live: ServeShell = {
        ...f.shell(behave.succeed()),
        terminal: {
          ...screen.terminal,
          rewrite: (text) => {
            draws += 1;
            if (draws === 3) throw new Error('the store could not be read');
            rewrite(text);
          },
        },
        signal: timeline.controller.signal,
        clock: timeline.clock,
        wait: timeline.wait,
        stateBranch: () => ({
          start: async () => {
            await timeline.lag(10_000);
            return { decision: 'ready' };
          },
          flush: async () => ({ kind: 'unchanged' }),
        }),
      };
      assert.equal(await runBrew(f.setup, live, request), 0, f.lines.join('\n'));
      assert.ok(draws > 3, `${draws} draws`);
    });
  });
});
