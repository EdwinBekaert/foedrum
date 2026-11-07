// `foedrum brew`'s live line on a terminal (ADR 0174), through runBrew. serve's shell with an
// in-memory store, fake worktrees, a fake GitHub and the scripted runner, over a fake screen; no
// process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { FlushResult } from '../../src/engine/state-branch-git.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import { brewFixture, idle, request, t0 } from '../helpers/brew-fixture.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { aborted, fakeScreen, SPINNER, withoutTime } from '../helpers/fake-screen.ts';
import { brewer, local, serveInputs } from '../helpers/serve-brewery.ts';

describe('runBrew', () => {
  const f = brewFixture();
  const { log, shell } = f;

  describe('with a live line on a terminal (ADR 0174)', () => {
    interface Live {
      /** How many seconds of the fake clock the brew runs before it is stopped. */
      seconds?: number;
      columns?: number | 'unknown';
      /** Runs inside each wait, with the number of waits so far. */
      onWait?: (waits: number, screen: ReturnType<typeof fakeScreen>) => void;
      runner?: BrewerRunner;
      /** What the state branch's flush answers, by the number of flushes so far. */
      flush?: (flushes: number) => FlushResult;
      /** Runs on the fresh store before the brew, to record what was there before it. */
      before?: () => void;
    }

    /** Brews with a terminal, a clock that only the waits move and a brewer that shows `progress`. */
    const brewLive = async (progress: AttemptProgress, more: Live = {}) => {
      const { seconds = 10, columns = 120, onWait, runner, flush, before } = more;
      // A test brews more than once: each brew gets the lock and the store of a fresh machine.
      f.lock = fakeLock('ann');
      f.store = { ...openSqliteEventStore(':memory:'), close: () => {} };
      before?.();
      const screen = fakeScreen(columns);
      const controller = new AbortController();
      const waits: number[] = [];
      let flushes = 0;
      let now = t0;
      const live = shell(behave.hang(progress), {
        terminal: screen.terminal,
        out: (line) => {
          f.lines.push(line);
          screen.print(line);
        },
        signal: controller.signal,
        clock: () => now,
        wait: async (ms, waiting) => {
          // The live line's wait beside a call lasts until the call ends: the clock moves only
          // with the brew's own waits, as before the line ran through its calls (#873).
          if (waiting !== controller.signal) return aborted(waiting);
          waits.push(ms);
          now = new Date(now.getTime() + ms);
          onWait?.(waits.length, screen);
          if (now.getTime() - t0.getTime() > seconds * 1000) controller.abort();
        },
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            flushes += 1;
            return flush?.(flushes) ?? { kind: 'unchanged' };
          },
        }),
        ...(runner === undefined ? {} : { runner: () => runner }),
      });
      const code = await runBrew(f.setup, live, request);
      return { code, screen, waits, flushes: () => flushes };
    };

    it('shows an attempt as step and attempt, elapsed time, turn and last tool, joined by " / "', async () => {
      const { code, screen } = await brewLive(
        { ...idle, turn: 14, lastTool: { name: 'Edit', word: 'src/schemas/primitives.ts' } },
        { seconds: 170 },
      );
      assert.equal(code, 1);
      assert.ok(
        screen.texts().includes('brew #1 / 2m 41s / turn 14 / Edit src/schemas/primitives.ts'),
        screen.texts().slice(-3).join('\n'),
      );
    });

    it("leads the line with the batch's time as `ordered <time> ago`, counted from when it was ordered, before the attempts (ADR 0179, ADR 0326)", async () => {
      const { screen } = await brewLive(
        { ...idle, turn: 14 },
        {
          seconds: 5,
          before: () => {
            const ordered = new Date(t0.getTime() - 5 * 60_000);
            log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, ordered);
          },
        },
      );
      // The lines of the attempt: those before it are drawn before the batch is known (#873).
      const attempt = screen.rewrites().filter((drawn) => drawn.includes('brew #1'));
      const times = attempt.map((drawn) => /^. \D+ ((?:\d+m )?\d+s) ago/.exec(drawn)?.[1]);
      assert.ok(times.length > 0, 'a live line is drawn');
      assert.ok(
        times.every((time) => /^5m \d+s$/.test(time ?? '')),
        times.join(' '),
      );
      assert.ok(times.includes('5m 3s'), times.join(' '));
      assert.ok(
        attempt.some((drawn) => /^. ordered 5m 3s ago \/ brew #1 \/ \d+s \/ turn 14$/.test(drawn)),
        screen.rewrites().join('\n'),
      );
      // The words lead every line of the attempt, not only the first one drawn.
      assert.ok(
        attempt.every((drawn) => /^. ordered (\d+m )?\d+s ago \/ brew #1 \/ /.test(drawn)),
        screen.rewrites().join('\n'),
      );
    });

    it("counts the batch's time from this brew's start, and says so, for a batch ordered with no time (ADR 0179, ADR 0326)", async () => {
      const { screen } = await brewLive(idle, {
        seconds: 5,
        before: () => {
          // A batch ordered before batch.ordered recorded when.
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          const old = {
            type: 'batch.ordered',
            batchId: '12-1',
            order: { issue: 12 },
            routeBy,
          } as const;
          f.store.withTransaction((tx) => tx.append(old));
        },
      });
      // The lines of the attempt: those before it are drawn before the batch is known (#873).
      const drawn = screen.rewrites().filter((each) => each.includes('brew #1'));
      const times = drawn.map((each) => /^. \D+ ((?:\d+m )?\d+s) ago/.exec(each)?.[1]);
      assert.ok(times.length > 0, 'a live line is drawn');
      assert.ok(
        // Seconds since this run's start at t0, never the minutes of an earlier order.
        times.every((time) => /^\d+s$/.test(time ?? '')),
        times.join(' '),
      );
      // And it moves: a time pinned at 0s would also be no minutes.
      assert.ok(times.includes('3s'), times.join(' '));
      // It claims no order time it does not have: the time counts from this brew's start.
      assert.ok(
        drawn.every((line) => /^. brew started \d+s ago \/ brew #1 \/ (\d+m )?\d+s$/.test(line)),
        drawn.join('\n'),
      );
      assert.ok(
        drawn.every((line) => !line.includes('ordered')),
        drawn.join('\n'),
      );
    });

    it("shows a batch's time as `ordered 0s ago` while the clock reads before its order (ADR 0179, ADR 0326)", async () => {
      const { screen } = await brewLive(idle, {
        seconds: 3,
        before: () => {
          const ordered = new Date(t0.getTime() + 10 * 60_000);
          log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, ordered);
        },
      });
      // The lines of the attempt: those before it are drawn before the batch is known (#873).
      const drawn = screen.rewrites().filter((each) => each.includes('brew #1'));
      assert.ok(drawn.length > 0, 'a live line is drawn');
      assert.ok(
        drawn.every((each) => each.startsWith(`${each[0]} ordered 0s ago / `)),
        screen.rewrites().join('\n'),
      );
    });

    it('counts the elapsed time as the plain lines do: whole seconds, then minutes from one', async () => {
      const { screen } = await brewLive({ ...idle, turn: 1 }, { seconds: 70 });
      const texts = screen.texts().map(withoutTime);
      assert.ok(texts.includes('brew #1 / turn 1'), texts.join('\n'));
      const times = screen.texts().map((text) => /^brew #1 \/ ((?:\d+m )?\d+s)/.exec(text)?.[1]);
      assert.ok(times.includes('59s'), times.join(' '));
      assert.ok(times.includes('1m 0s'), times.join(' '));
    });

    it('shows only the step, attempt and elapsed time for an attempt whose runner reports no brewer fields, as a check step does', async () => {
      const { screen } = await brewLive(idle, { seconds: 5 });
      const attempts = screen.texts().filter((text) => text.startsWith('brew'));
      assert.ok(attempts.length > 0, 'the attempt is shown');
      for (const text of attempts) assert.match(text, /^brew #1 \/ (\d+m )?\d+s$/);
    });

    it('shows setup in place of the turn and the tool while the setup of the repository runs', async () => {
      const { screen } = await brewLive({ ...idle, settingUp: true }, { seconds: 5 });
      const attempts = screen.texts().filter((text) => text.startsWith('brew'));
      assert.ok(attempts.length > 0, 'the attempt is shown');
      for (const text of attempts) assert.match(text, /^brew #1 \/ (\d+m )?\d+s \/ setup$/);
    });

    it('shows the last tool as its name and the one safe word the runner reduced it to, or the name alone', async () => {
      const cases: [{ name: string; word?: string } | undefined, string][] = [
        [{ name: 'Read', word: 'src/a.ts' }, 'brew #1 / turn 3 / Read src/a.ts'],
        [{ name: 'Read', word: 'outside' }, 'brew #1 / turn 3 / Read outside'],
        [{ name: 'Write', word: '(left out)' }, 'brew #1 / turn 3 / Write (left out)'],
        [{ name: 'Bash', word: 'git status' }, 'brew #1 / turn 3 / Bash git status'],
        [{ name: 'Grep' }, 'brew #1 / turn 3 / Grep'],
        [undefined, 'brew #1 / turn 3'],
      ];
      for (const [lastTool, expected] of cases) {
        const progress = { ...idle, turn: 3, ...(lastTool === undefined ? {} : { lastTool }) };
        const { screen } = await brewLive(progress, { seconds: 3 });
        const shown = screen.texts().map(withoutTime);
        assert.ok(shown.includes(expected), `${expected}\n${shown.join('\n')}`);
      }
    });

    it('adds denied after the last tool while the runner reports a denial, and not otherwise', async () => {
      const tool = { name: 'Bash', word: 'git push' };
      const held = await brewLive(
        { ...idle, turn: 3, lastTool: tool, denied: true },
        { seconds: 3 },
      );
      const heldTexts = held.screen.texts().map(withoutTime);
      assert.ok(
        heldTexts.includes('brew #1 / turn 3 / Bash git push / denied'),
        heldTexts.join('\n'),
      );
      const clear = await brewLive(
        { ...idle, turn: 3, lastTool: tool, denied: false },
        { seconds: 3 },
      );
      const clearTexts = clear.screen.texts().map(withoutTime);
      assert.ok(clearTexts.includes('brew #1 / turn 3 / Bash git push'), clearTexts.join('\n'));
      assert.ok(
        clearTexts.every((text) => !text.includes('denied')),
        clearTexts.join('\n'),
      );
    });

    it('shows every code point outside U+0020 to U+007E as an escape with four hex digits, the name of the tool and the path alike', async () => {
      const lastTool = { name: 'Ed⁦it\u0007\n\u007f', word: 'src/Ж/‮\u{1f600}.ts' };
      const { screen } = await brewLive({ ...idle, turn: 3, lastTool }, { seconds: 3 });
      const expected =
        'brew #1 / turn 3 / Ed\\u2066it\\u0007\\u000a\\u007f src/\\u0416/\\u202e\\ud83d\\ude00.ts';
      const shown = screen.texts().map(withoutTime);
      assert.ok(
        shown.some((text) => text.toLowerCase() === expected.toLowerCase()),
        shown.join('\n'),
      );
      for (const drawn of screen.rewrites()) assert.match(drawn, /^[ -~]*$/);
    });

    it('cuts the name of the tool to 64 characters before it escapes it', async () => {
      const plain = await brewLive(
        { ...idle, turn: 3, lastTool: { name: 'A'.repeat(100) } },
        { seconds: 3, columns: 500 },
      );
      assert.ok(
        plain.screen
          .texts()
          .map(withoutTime)
          .includes(`brew #1 / turn 3 / ${'A'.repeat(64)}`),
        plain.screen.texts().join('\n'),
      );
      const wide = await brewLive(
        { ...idle, turn: 3, lastTool: { name: 'é'.repeat(70) } },
        { seconds: 3, columns: 500 },
      );
      const escaped = '\\u00e9'.repeat(64);
      assert.ok(
        wide.screen.texts().map(withoutTime).includes(`brew #1 / turn 3 / ${escaped}`),
        wide.screen.texts().join('\n'),
      );
    });

    it("cuts the whole line, spinner included, to the width of the terminal less one, and to 79 when it is unknown, keeping the batch's time and its words first", async () => {
      const lastTool = { name: 'Edit', word: 'x'.repeat(300) };
      const narrow = await brewLive({ ...idle, turn: 3, lastTool }, { seconds: 3, columns: 40 });
      // The lines of the attempt: a line of what the command does is cut short too (#873).
      const full = narrow.screen
        .rewrites()
        .filter((drawn) => drawn.length >= 39 && drawn.includes('brew #1'));
      assert.ok(full.length > 0, 'a line fills the terminal');
      assert.ok(full.every((drawn) => drawn.length === 39));
      assert.ok(narrow.screen.rewrites().every((drawn) => drawn.length <= 39));
      // Cut from the end: the spinner and the batch's time, with its words, stay (ADR 0179, ADR
      // 0326). A batch this brew ordered has its order time, so it says `ordered`.
      assert.ok(
        full.every((drawn) => /^. ordered \d+s ago \/ brew #1 \/ /.test(drawn)),
        full.join('\n'),
      );
      // Too narrow for the words: the line is cut inside them, and nothing else shows. Before the
      // batch is known they are `brew started` (#873).
      const cut = await brewLive({ ...idle, turn: 3, lastTool }, { seconds: 3, columns: 9 });
      assert.ok(cut.screen.rewrites().length > 0, 'a live line is drawn');
      assert.ok(
        cut.screen.rewrites().every((drawn) => /^. (?:ordere|brew s)$/.test(drawn)),
        cut.screen.rewrites().join('\n'),
      );
      const unknown = await brewLive(
        { ...idle, turn: 3, lastTool },
        { seconds: 3, columns: 'unknown' },
      );
      const lengths = unknown.screen.rewrites().map((drawn) => drawn.length);
      assert.equal(Math.max(...lengths), 79);
    });

    it('redraws at once when the terminal is resized, to its new width, and stops listening at the end', async () => {
      const lastTool = { name: 'Edit', word: 'x'.repeat(300) };
      let seen: { before: number; after: number; line: string | undefined } | undefined;
      const { screen } = await brewLive(
        { ...idle, turn: 3, lastTool },
        {
          seconds: 8,
          onWait: (waits, screen) => {
            if (waits !== 3) return;
            const before = screen.rewrites().length;
            screen.resize(30);
            seen = { before, after: screen.rewrites().length, line: screen.drawn() };
          },
        },
      );
      assert.ok(seen !== undefined && seen.after > seen.before, JSON.stringify(seen));
      assert.equal(seen.line?.length, 29);
      assert.equal(screen.resizers.size, 0);
    });

    it('redraws about once a second on the wait of the shell, while the tick stays every 5 s', async () => {
      const { screen, waits, flushes } = await brewLive(
        { ...idle, turn: 3 },
        { seconds: 30, columns: 120 },
      );
      assert.ok(waits.length > 0 && waits.every((ms) => ms <= 1_000), waits.join(' '));
      const drawn = screen.rewrites().length;
      assert.ok(drawn >= 25 && drawn <= 45, `${drawn} redraws in 30 s`);
      // A tick flushes the state branch once: every 5 s, not every redraw.
      assert.ok(flushes() >= 5 && flushes() <= 9, `${flushes()} ticks in 30 s`);
    });

    it('turns the spinner one frame at each redraw, through its four frames in order', async () => {
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 20 });
      const frames = new Set<string>();
      let previous: string | undefined;
      let steps = 0;
      for (const event of screen.events) {
        if (!event.startsWith('rewrite: ')) {
          previous = undefined;
          continue;
        }
        const frame = event.charAt(9);
        frames.add(frame);
        if (previous !== undefined) {
          const next = SPINNER[(SPINNER.indexOf(previous) + 1) % SPINNER.length];
          assert.equal(frame, next, `after ${previous}`);
          steps += 1;
        }
        previous = frame;
      }
      assert.deepEqual([...frames].sort(), [...SPINNER].sort());
      assert.ok(steps >= 10, `${steps} steps`);
    });

    it('prints no 30 s progress line while it keeps a live line', async () => {
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 70 });
      assert.ok(screen.rewrites().length > 0, 'a live line is drawn');
      assert.deepStrictEqual(
        f.lines.filter((line) => line.includes('running for')),
        [],
      );
    });

    it('clears the live line, prints a lasting line, and draws the live line again', async () => {
      const { screen } = await brewLive(
        { ...idle, turn: 3 },
        {
          seconds: 20,
          flush: (flushes) =>
            flushes === 3 ? { kind: 'failed', reason: 'offline' } : { kind: 'unchanged' },
        },
      );
      const at = screen.events.indexOf(
        'out: foedrum brew: the state branch was not pushed: offline',
      );
      assert.ok(at > 0, screen.events.join('\n'));
      assert.equal(screen.events[at - 1], 'clear');
      assert.ok(screen.events[at + 1]?.startsWith('rewrite: '), screen.events[at + 1]);
      assert.deepStrictEqual(screen.printedOver, []);
    });

    it('clears the live line before it exits when it is stopped, and leaves the last line of today', async () => {
      const { code, screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 10 });
      assert.equal(code, 1);
      assert.ok(screen.rewrites().length > 0, 'a live line was drawn');
      assert.ok(f.lines.at(-1)?.startsWith('foedrum brew: stopped; '), f.lines.at(-1));
      assert.equal(screen.drawn(), undefined);
      assert.ok(!screen.events.at(-1)?.startsWith('rewrite: '), screen.events.at(-1));
    });

    /** Two Tasters' lens steps side by side (ADR 0168), on a batch routed to their recipe. */
    const sideBySide = (): void => {
      const taster = brewer
        .replace('"name": "cellarman"', '"name": "taster"')
        .replace('"doc": "brew.md", "schema": "outDoc"', '"doc": "taste.md", "schema": "tasting"')
        .replace('"allow": ["Read", "Write"]', '"allow": ["Read"]')
        .replace('"produces": "commits"', '"produces": "report"')
        .replace('"access": "write"', '"access": "read"')
        .replace('"git": { "commit": true },', '');
      const tasting = JSON.stringify({
        name: 'tasting',
        description: 'Two lenses side by side.',
        testFirst: false,
        steps: [
          {
            id: 'tasting',
            parallel: [
              { id: 'security', brewer: 'taster', lens: 'plan/security' },
              { id: 'correctness', brewer: 'taster', lens: 'plan/correctness' },
            ],
          },
        ],
      });
      const inputs = serveInputs({
        files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }) },
      });
      const { brewery } = inputs.files;
      const result = serveSetup({
        ...inputs,
        files: {
          ...inputs.files,
          brewery: {
            ...brewery,
            recipes: [...brewery.recipes, { path: 'recipes/tasting.jsonc', text: tasting }],
            brewers: [...brewery.brewers, { path: 'brewers/taster.md', text: taster }],
            lenses: [
              { path: 'lenses/plan/security.md', text: 'Security.' },
              { path: 'lenses/plan/correctness.md', text: 'Correctness.' },
            ],
          },
        },
      });
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            {
              number: 12,
              labels: ['recipe:tasting'],
              author: 'ann',
              title: 'Taste',
              body: 'Both.',
            },
          ],
        },
      });
    };

    it('shows the attempts of a parallel group on the one line, joined by " ; ", in the order of the plain lines', async () => {
      sideBySide();
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 5 });
      const times = / \/ (\d+m )?\d+s(?= \/|$| ;)/g;
      const shown = screen.texts().map((text) => text.replace(times, ''));
      assert.ok(shown.includes('security #1 / turn 3 ; correctness #1 / turn 3'), shown.join('\n'));
      assert.ok(
        f.lines.some((line) => line.includes('security #1') && line.includes('correctness #1')),
        f.lines.join('\n'),
      );
    });

    it('cuts the line of a group from the end when even the steps and attempts alone do not fit (#873)', async () => {
      sideBySide();
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 30, columns: 30 });
      const group = screen.rewrites().filter((drawn) => drawn.includes('security'));
      assert.ok(group.length > 0, screen.rewrites().join('\n'));
      for (const drawn of group) {
        assert.equal(drawn.length, 29, drawn);
        assert.match(drawn, /^. ordered \d+s ago \/ secur/);
      }
    });

    it('lets the attempts of a group give up their last parts together, before one is cut off (#873)', async () => {
      sideBySide();
      // Wide enough for the steps with their times, too narrow for the turn.
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 30, columns: 64 });
      const group = screen.rewrites().filter((drawn) => drawn.includes('security'));
      assert.ok(group.length > 0, screen.rewrites().join('\n'));
      for (const drawn of group) {
        assert.match(drawn, /^. ordered \d+s ago \/ security #1 \/ \d+s ; correctness #1 \/ \d+s$/);
      }
    });

    it('draws no line with only its spinner: once no attempt runs, the live line says what it waits for', async () => {
      // The brew attempt runs for six redraws, then ends; the pull request step runs no attempt.
      const inner = fakeBrewerRunner(() => behave.succeed('Brewed'));
      let release: () => void = () => {};
      const released = new Promise<void>((done) => {
        release = done;
      });
      const runner: BrewerRunner = {
        start: (attempt) => {
          const run = inner.start(attempt);
          return { ended: released.then(() => run.ended), stop: run.stop };
        },
        progress: () => ({ ...idle, turn: 3 }),
      };
      const { code, screen, waits } = await brewLive(
        { ...idle, turn: 3 },
        {
          seconds: 300,
          runner,
          onWait: (count) => {
            if (count === 6) release();
          },
        },
      );
      assert.equal(code, 0, f.lines.join('\n'));
      assert.ok(waits.length > 6, `${waits.length} waits: brew went on after the attempt ended`);
      assert.ok(screen.rewrites().length > 0, 'a live line was drawn');
      // Without an attempt the line says what the command does or that it is between steps (#873).
      const texts = screen.texts();
      assert.ok(
        texts.some((text) => /^brew #1 \/ /.test(text)),
        texts.join('\n'),
      );
      for (const text of texts) assert.match(text, /^(?:brew #1 \/ |[a-z])/);
    });

    it('clears the live line before it exits, whatever the exit code', async () => {
      const exits: [string, ReturnType<typeof behave.succeed>, number][] = [
        ['on tap', behave.succeed('Brewed'), 0],
        ['needs input', behave.needInput(), 4],
      ];
      for (const [name, ending, exitCode] of exits) {
        f.lines.length = 0;
        const inner = fakeBrewerRunner(() => ending);
        let release: () => void = () => {};
        const released = new Promise<void>((done) => {
          release = done;
        });
        let over = false;
        const runner: BrewerRunner = {
          start: (attempt) => {
            const run = inner.start(attempt);
            const ended = released
              .then(() => run.ended)
              .then((end) => {
                over = true;
                return end;
              });
            return { ended, stop: run.stop };
          },
          progress: () => (over ? undefined : { ...idle, turn: 3 }),
        };
        const { code, screen } = await brewLive(
          { ...idle, turn: 3 },
          {
            seconds: 300,
            runner,
            onWait: (waits) => {
              if (waits === 6) release();
            },
          },
        );
        assert.equal(code, exitCode, `${name}: ${f.lines.join('\n')}`);
        assert.ok(screen.rewrites().length >= 5, `${name}: a live line was drawn`);
        assert.equal(screen.drawn(), undefined, name);
        assert.ok(
          !screen.events.at(-1)?.startsWith('rewrite: '),
          `${name}: ${screen.events.at(-1)}`,
        );
        assert.deepStrictEqual(screen.printedOver, [], name);
      }
    });
  });
});
