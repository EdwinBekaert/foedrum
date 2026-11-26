// `foedrum serve`'s live line on a terminal (ADR 0427, #1172), through runServe. serve's shell of
// serve.test.ts over a fake screen and a virtual clock, with a runner whose attempts hang so that a
// batch is driven for as long as the test looks; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';
import { virtualTimeline } from '../helpers/virtual-timeline.ts';

const SPINNER = ['|', '/', '-', '\\'];

/** A time as the lines say it: whole seconds, and minutes from one. */
const TIME = String.raw`(?:\d+m )?\d+s`;

/** What the runner reports of the attempt of each batch: the two differ, so a part is told by its tool. */
const progressOf = (batchId: string): AttemptProgress =>
  batchId === '12-1'
    ? {
        lastProgressAt: t0,
        turnsWithoutProgress: 0,
        turn: 14,
        lastTool: { name: 'Edit', word: 'src/schemas/primitives.ts' },
      }
    : {
        lastProgressAt: t0,
        turnsWithoutProgress: 0,
        turn: 9,
        lastTool: { name: 'Grep', word: 'src/engine/driver.ts' },
      };

/** The part of the live line that one batch of the Cellar draws, as brew draws a batch (ADR 0174). */
const partOf = (turn: number, tool: string): RegExp =>
  new RegExp(String.raw`^ordered ${TIME} ago / brew #1 / ${TIME} / turn ${turn} / ${tool}$`);
const EDIT_PART = partOf(14, String.raw`Edit src/schemas/primitives\.ts`);
const GREP_PART = partOf(9, String.raw`Grep src/engine/driver\.ts`);

/** The parts of a live line: its mark and a space, then one part for each batch, joined by " ; ". */
const partsOf = (line: string): string[] => line.slice(2).split(' ; ');

describe('runServe', () => {
  const f = serveFixture();

  describe('with a live line on a terminal (ADR 0427)', () => {
    interface Served {
      /** How many seconds of the virtual clock serve runs before it is stopped. */
      seconds?: number;
      columns?: number;
      /** Whether standard output is a terminal; it is by default. */
      terminal?: boolean;
      /** How many batches are ordered: the fixture's one by default; none, or a second one beside it. */
      batches?: 0 | 1 | 2;
      /** Whether the attempts hang, so that the batches are driven all along; they do by default. */
      hang?: boolean;
    }

    /** Serves with a terminal and a virtual clock; the attempts of the batches report `progressOf`. */
    const served = async ({
      seconds = 30,
      columns = 120,
      terminal = true,
      batches = 1,
      hang = true,
    }: Served = {}) => {
      if (batches === 0) f.store = { ...openSqliteEventStore(':memory:'), close: () => {} };
      if (batches === 2) {
        const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
        log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
        log.issue(
          { kind: 'route', batchId: '13-1', recipe: 'stout', reason: 'label', source: 'label' },
          t0,
        );
      }
      const screen = fakeScreen(columns);
      const timeline = virtualTimeline(t0, seconds * 1000);
      const runner = fakeBrewerRunner(({ ref }) => behave.hang(progressOf(ref.batchId)));
      const shell = f.shell({
        clock: timeline.clock,
        wait: timeline.wait,
        signal: timeline.controller.signal,
        out: (line) => {
          f.lines.push(line);
          screen.print(line);
        },
        ...(terminal ? { terminal: screen.terminal } : {}),
        ...(hang ? { runner: () => runner } : {}),
      });
      const code = await runServe(f.setup, shell);
      return { code, screen, started: runner.started };
    };

    it("draws the batch it drives as brew draws a batch: the mark, the batch's time, then its attempt with the turn and the last tool", async () => {
      const { code, screen } = await served({ batches: 1 });
      assert.equal(code, 0, f.lines.join('\n'));
      const drawn = screen.rewrites().filter((line) => EDIT_PART.test(line.slice(2)));
      assert.ok(drawn.length > 0, screen.rewrites().join('\n'));
      for (const line of drawn) assert.match(line, /^[|/\\-] ordered /);
    });

    it('draws one part for each batch it drives, side by side on the one line', async () => {
      const { code, screen, started } = await served({ batches: 2 });
      assert.equal(code, 0, f.lines.join('\n'));
      // Both batches are driven at once: the line has two parts to draw.
      assert.deepStrictEqual(started.map(({ ref }) => ref.batchId).sort(), ['12-1', '13-1']);
      const both = screen.rewrites().filter((line) => {
        const parts = partsOf(line);
        return (
          parts.length === 2 &&
          parts.some((part) => EDIT_PART.test(part)) &&
          parts.some((part) => GREP_PART.test(part))
        );
      });
      assert.ok(both.length > 0, screen.rewrites().join('\n'));
    });

    it('lets the parts give up their last words together before any part is cut', async () => {
      // Too narrow for both tools, wide enough for both parts without them.
      const { screen } = await served({ batches: 2, columns: 100 });
      const lines = screen.rewrites();
      for (const line of lines) {
        assert.equal(line.includes('Edit'), line.includes('Grep'), line);
      }
      const shortened = lines.filter(
        (line) =>
          !line.includes('Edit') && /turn 14/.test(line) && /turn 9/.test(line) && / ; /.test(line),
      );
      assert.ok(shortened.length > 0, lines.join('\n'));
    });

    it("fits every line to the terminal's width less one, and keeps both parts while they fit", async () => {
      const { screen } = await served({ batches: 2, columns: 80 });
      const lines = screen.rewrites();
      assert.ok(lines.length > 0, 'a live line is drawn');
      for (const line of lines) assert.ok(line.length <= 79, `${line.length}: ${line}`);
      assert.ok(
        lines.some((line) => partsOf(line).length === 2 && /brew #1.* ; .*brew #1/.test(line)),
        lines.join('\n'),
      );
    });

    it('cuts the line from its end when even the shortest parts do not fit', async () => {
      const { screen } = await served({ batches: 2, columns: 40 });
      const lines = screen.rewrites().filter((line) => line.includes('brew #1'));
      assert.ok(lines.length > 0, screen.rewrites().join('\n'));
      for (const line of lines) assert.equal(line.length, 39, line);
    });

    it('redraws about each second, though a tick comes each 5 s: the times in the line move', async () => {
      const { screen } = await served({ seconds: 30 });
      const words = new Set(
        screen
          .rewrites()
          .filter((line) => line.includes('brew #1'))
          // Without the mark, which turns on its own timer.
          .map((line) => line.slice(1)),
      );
      assert.ok(words.size >= 20, `${words.size} different lines in 30 s`);
    });

    it('turns the mark on a timer of its own, through every frame of the terminal', async () => {
      const { screen } = await served({ seconds: 10 });
      const shown = new Set(screen.rewrites().map((line) => line[0]));
      assert.deepStrictEqual([...shown].sort(), [...SPINNER].sort());
    });

    it('shows that it waits for work while it has no batch to drive', async () => {
      const { code, screen } = await served({ batches: 0, seconds: 30 });
      assert.equal(code, 0, f.lines.join('\n'));
      const last = screen.rewrites().at(-1);
      assert.match(last ?? '', /^[|/\\-] waiting for work\b/);
    });

    it('shows that it waits for work again once the batch it drove is done', async () => {
      const { code, screen } = await served({ hang: false, seconds: 60 });
      assert.equal(code, 0, f.lines.join('\n'));
      assert.match(screen.rewrites().at(-1) ?? '', /^[|/\\-] waiting for work\b/);
    });

    it('prints each lasting line over a cleared live line, and clears the live line when it stops', async () => {
      const { code, screen } = await served({ batches: 2 });
      assert.equal(code, 0, f.lines.join('\n'));
      assert.deepStrictEqual(screen.printedOver, []);
      // A line printed while a live line had been drawn before: the check is not about an empty run.
      const over = screen.events.findIndex(
        (event, at) =>
          event.startsWith('out: ') &&
          screen.events.slice(0, at).some((earlier) => earlier.startsWith('rewrite: ')),
      );
      assert.ok(over > 0, screen.events.join('\n'));
      assert.equal(screen.events[over - 1], 'clear');
      assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
      assert.equal(screen.drawn(), undefined);
      assert.equal(screen.events.at(-1), 'out: foedrum serve: stopped');
    });

    it('prints no still-running line while its live line moves, however long it is quiet', async () => {
      const { code, screen } = await served({ seconds: 180 });
      assert.equal(code, 0, f.lines.join('\n'));
      assert.ok(screen.rewrites().length > 0, 'a live line is drawn');
      assert.deepStrictEqual(
        f.lines.filter((line) => line.includes('still running')),
        [],
      );
    });

    it('still prints its still-running line each 60 s of quiet where it draws no live line: regression test', async () => {
      const { code, screen } = await served({ seconds: 180, terminal: false });
      assert.equal(code, 0, f.lines.join('\n'));
      assert.deepStrictEqual(screen.rewrites(), []);
      const alive = f.lines.filter(
        (line) => line === 'foedrum serve: still running for Acme/Brewery',
      );
      assert.ok(alive.length >= 2, f.lines.join('\n'));
    });
  });
});
