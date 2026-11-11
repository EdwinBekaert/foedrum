// `foedrum brew`'s live line from the command's first second to its last (#873), through runBrew.
// serve's shell with an in-memory store, fake worktrees, a fake GitHub and the scripted runner,
// over a fake screen and a virtual clock; a GitHub call, a push, a worktree or a cleanup that takes
// seconds is a `lag` of that clock, and each test reads what the screen shows while it lasts. No
// process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { brewFixture, idle, request, t0 } from '../helpers/brew-fixture.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { flagValue, ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';
import { FAKE_COMMIT, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { virtualTimeline } from '../helpers/virtual-timeline.ts';

/** What the screen showed while one slow call lasted. */
interface Seen {
  /** The live line on screen when the call began, if any. */
  entry: string | undefined;
  /** Every live line drawn while the call lasted, in order. */
  during: string[];
}

/** A GitHub call as the tests name it: its method and its path on the API. */
interface Call {
  method: string;
  path: string;
}

/** How long a slow call takes, in seconds of the virtual clock. */
type Slow = (call: Call) => number | undefined;

/** A runner around the scripted one; `later` settles after that many ms of the virtual clock. */
type Wrapped = (inner: BrewerRunner, later: (ms: number) => Promise<void>) => BrewerRunner;

interface Timed {
  /** How many seconds of the virtual clock the brew runs before it is stopped. */
  seconds?: number;
  columns?: number;
  /** The seconds each GitHub call takes, or none. */
  gh?: Slow;
  /** The seconds the state branch's start takes. */
  stateBranch?: number;
  /** The seconds the worktree of an attempt takes to make, by the attempt's step. */
  worktree?: (stepId: string) => number | undefined;
  /** The seconds the push of the branch takes. */
  push?: number;
  /** The seconds the clean of the worktrees takes. */
  clean?: number;
  /** What is brewed; the issue 12 of the Brewery by default. */
  request?: BrewRequest;
  /** Whether standard output is a terminal; it is by default. */
  terminal?: boolean;
  /** What each attempt does; the cellarman succeeds and every other step hangs by default. */
  script?: (attempt: AttemptStart) => Behaviour;
  /** Wraps the runner, to hold an attempt's end back on the virtual clock. */
  runner?: Wrapped;
}

/** The progress a running Taster reports: a turn and a tool with a path, as a real one does. */
const working = {
  ...idle,
  turn: 14,
  lastTool: { name: 'Edit', word: 'src/schemas/primitives.ts' },
};

const TASTERS = ['correctness', 'acceptance', 'security'] as const;

/** The live line names this activity: a spinner, the batch's time, then the activity's words. */
const names = (seen: Seen, words: RegExp): void => {
  assert.ok(seen.entry !== undefined, 'a live line is on screen when the call begins');
  assert.match(seen.entry, /^[|/\\-] (?:ordered|brew started) (?:\d+m )?\d+s ago \/ /);
  assert.match(seen.entry, words);
  for (const drawn of seen.during) assert.match(drawn, words);
};

/** A call of `ms` milliseconds moved the line: one redraw about each second, not the same text. */
const moved = (seen: Seen, ms: number): void => {
  const seconds = ms / 1000;
  // Without the mark, which turns on its own timer: the words themselves are drawn again.
  const words = new Set(seen.during.map((drawn) => drawn.slice(1)));
  assert.ok(
    words.size >= seconds - 3,
    `${words.size} redraws in ${seconds} s:\n${seen.during.join('\n')}`,
  );
};

describe('runBrew', () => {
  const f = brewFixture();

  describe('with a live line from the first second to the last (#873)', () => {
    /** Brews with a terminal and a virtual clock; the calls that take seconds are in `more`. */
    const brewTimed = async (more: Timed = {}) => {
      const { seconds = 120, columns = 120, gh, script, runner: wrap } = more;
      const screen = fakeScreen(columns);
      const timeline = virtualTimeline(t0, seconds * 1000);
      const seen = new Map<string, Seen>();
      const lagged = async (name: string, ms: number): Promise<void> => {
        const from = screen.events.length;
        const entry = screen.drawn();
        await timeline.lag(ms);
        const during = screen.events
          .slice(from)
          .filter((event) => event.startsWith('rewrite: '))
          .map((event) => event.slice(9));
        seen.set(name, { entry, during });
      };
      const base = ghOver(f.api.fetch).exec;
      const lagGh: ExecProcess = async (file, args, options) => {
        const method = flagValue(args, '--method') ?? 'GET';
        const path = (args.at(-1) === '-' ? args.at(-3) : args.at(-1)) ?? '';
        const ms = gh?.({ method, path });
        if (ms !== undefined) await lagged(`${method} ${path}`, ms * 1000);
        return base(file, args, options);
      };
      const inner = fakeBrewerRunner(
        (attempt) =>
          script?.(attempt) ??
          (attempt.ref.stepId === 'brew' ? behave.succeed('Brewed') : behave.hang(working)),
      );
      const runner = wrap === undefined ? inner : wrap(inner, timeline.later);
      const stock = f.shell(behave.succeed());
      const live: ServeShell = {
        ...stock,
        ...(more.terminal === false ? {} : { terminal: screen.terminal }),
        out: (line) => {
          f.lines.push(line);
          screen.print(line);
        },
        signal: timeline.controller.signal,
        clock: timeline.clock,
        wait: timeline.wait,
        stateBranch: () => ({
          start: async () => {
            if (more.stateBranch !== undefined)
              await lagged('state branch', more.stateBranch * 1000);
            return { decision: 'ready' };
          },
          flush: async () => ({ kind: 'unchanged' }),
        }),
        worktrees: async () => {
          const made = fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') });
          return {
            ...made,
            create: async (ref, base) => {
              const ms = more.worktree?.(ref.stepId);
              if (ms !== undefined) await lagged(`worktree ${ref.stepId}`, ms * 1000);
              return made.create(ref, base);
            },
            // The clean of the batch's worktrees, never the one of every batch at the start.
            clean: async (claims, scope) => {
              if (more.clean !== undefined && scope?.batchId !== undefined) {
                await lagged('clean', more.clean * 1000);
              }
              return made.clean(claims, scope);
            },
          };
        },
        push: (repository) => ({
          ...stock.push(repository),
          commit: async () => FAKE_COMMIT,
          push: async () => {
            if (more.push !== undefined) await lagged('push', more.push * 1000);
          },
        }),
        runner: () => runner,
        gh: lagGh,
      };
      const code = await runBrew(f.setup, live, more.request ?? request);
      return { code, screen, seen, started: inner.started };
    };

    const call = (method: string, path: RegExp, seconds: number, nth = 1): Slow => {
      let matched = 0;
      return (each) => {
        if (each.method !== method || !path.test(each.path)) return undefined;
        matched += 1;
        return matched === nth ? seconds : undefined;
      };
    };

    it('draws a live line before the state branch is read and before gh says who is logged in', async () => {
      const { seen } = await brewTimed({
        stateBranch: 20,
        gh: call('GET', /^\/user$/, 20),
      });
      const branch = seen.get('state branch') ?? assert.fail('the state branch was not read');
      const login = seen.get('GET /user') ?? assert.fail('gh was not asked who is logged in');
      assert.ok(branch.entry !== undefined, 'a live line is on screen as the command starts');
      assert.ok(login.entry !== undefined, 'a live line is on screen while gh answers');
      moved(branch, 20_000);
      moved(login, 20_000);
    });

    it('says starting while the driver is wired: regression test', async () => {
      const { seen } = await brewTimed({ stateBranch: 5 });
      const branch = seen.get('state branch') ?? assert.fail('the state branch was not read');
      assert.match(branch.entry ?? '', / \/ starting$/);
    });

    it('says only the words the design names while no attempt runs: regression test', async () => {
      const { screen } = await brewTimed({ seconds: 20 });
      // Every word one plain brew says of itself is one the design names.
      const known =
        /\/ (?:starting|routing|opening the Brewery issue|writing the status comment|opening the pull request|cleaning up the worktrees of the batch|between steps|applying \S+|claiming \S+)$/;
      const words = screen.rewrites().filter((drawn) => !/ #\d+ \/ /.test(drawn));
      assert.ok(words.length > 0, screen.rewrites().join('\n'));
      for (const drawn of words) assert.match(drawn.slice(1), known);
    });

    it('names the routing, and keeps moving, while GitHub is slow to read the labels of the order', async () => {
      const { seen } = await brewTimed({ gh: call('GET', /\/issues\/12$/, 25) });
      const routing = seen.get('GET /repos/Acme/Brewery/issues/12') ?? assert.fail('not read');
      names(routing, /\brout(?:e|es|ing)\b/i);
      moved(routing, 25_000);
    });

    it('names the status comment, and keeps moving, while it is written', async () => {
      const { seen } = await brewTimed({ gh: call('POST', /\/issues\/12\/comments$/, 25) });
      const written =
        seen.get('POST /repos/Acme/Brewery/issues/12/comments') ?? assert.fail('none');
      names(written, /status comment/i);
      // The batch is known by then, so its time says when it was ordered.
      assert.match(written.entry ?? '', /^. ordered /);
      moved(written, 25_000);
    });

    it('names the pull requests, and keeps moving, while a brew of an on-tap batch reads their ends', async () => {
      const first = await brewTimed({ script: () => behave.succeed('Brewed') });
      assert.equal(first.code, 0, f.lines.join('\n'));
      const merged = fakeGitHubApi({
        login: 'ann',
        issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'T' }] },
        instead: (method, { pathname }) =>
          method === 'GET' && /\/pulls\/\d+$/.test(pathname)
            ? { status: 200, body: { state: 'closed', merged: true } }
            : undefined,
      });
      f.api = merged;
      f.lock = fakeLock('ann');
      const { seen } = await brewTimed({ gh: call('GET', /\/pulls\/\d+$/, 25) });
      const read = [...seen.values()][0] ?? assert.fail('no pull request was read');
      names(read, /reading its pull requests$/);
      moved(read, 25_000);
    });

    it('keeps a live line on screen while the worktree of the first attempt is made', async () => {
      const { seen } = await brewTimed({ worktree: (step) => (step === 'brew' ? 25 : undefined) });
      const made = seen.get('worktree brew') ?? assert.fail('no worktree was made');
      assert.ok(made.entry !== undefined, 'a live line is on screen before step #1 started');
      assert.match(made.entry, /ago \/ \S/);
      moved(made, 25_000);
    });

    describe('for an issue of a target repository (ADR 0105)', () => {
      const target: BrewRequest = { ...request, target: { alias: 'web', issue: 7 } };
      const claimed = () => {
        const web = { alias: 'web', intake: { labels: ['foedrum'] } };
        const result = serveSetup(
          serveInputs({
            files: {
              ...serveInputs().files,
              config: config({}, web),
              local: local({ workRoot: f.dir.path }),
            },
          }),
        );
        f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
        f.api = fakeGitHubApi({
          login: 'ann',
          issues: {
            'acme/web': [
              { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark', body: 'Dark.' },
            ],
          },
        });
      };

      it('names an effect of no other kind by its own name: regression test', async () => {
        claimed();
        const { screen } = await brewTimed({ request: target });
        assert.ok(
          screen.rewrites().some((drawn) => / \/ applying \S+$/.test(drawn)),
          screen.rewrites().join('\n'),
        );
      });

      it('names the claim, and keeps moving, while it is made', async () => {
        claimed();
        const { seen } = await brewTimed({ request: target, gh: call('POST', /\/git\/refs$/, 25) });
        const made = [...seen.values()][0] ?? assert.fail('no claim was made');
        names(made, /\bclaim/i);
        moved(made, 25_000);
      });

      it('names the labels, and keeps moving, while it reads them on the way to a refusal', async () => {
        claimed();
        // The target issue is read more than once: `seen` keeps the last, the refusal's.
        const { seen } = await brewTimed({
          request: target,
          gh: ({ method, path }) =>
            method === 'GET' && /^\/repos\/acme\/web\/issues\/7$/.test(path) ? 25 : undefined,
        });
        const read = [...seen.values()][0] ?? assert.fail('the labels were not read');
        names(read, /reading its labels$/);
        moved(read, 25_000);
      });

      it('names the Brewery issue, and keeps moving, while it is opened', async () => {
        claimed();
        const { seen } = await brewTimed({
          request: target,
          gh: call('POST', /^\/repos\/Acme\/Brewery\/issues$/, 25),
        });
        const opened = [...seen.values()][0] ?? assert.fail('no Brewery issue was opened');
        names(opened, /Brewery issue/i);
        moved(opened, 25_000);
      });
    });
    describe('through a parallel group of three Tasters and the steps after it', () => {
      /** The Brewery's recipe `tasting`: the cellarman brews, three Tasters side by side, a pull request. */
      const tasting = () => {
        const taster = brewer
          .replace('"name": "cellarman"', '"name": "taster"')
          .replace('"doc": "brew.md", "schema": "outDoc"', '"doc": "taste.md", "schema": "tasting"')
          .replace('"allow": ["Read", "Write"]', '"allow": ["Read"]')
          .replace('"produces": "commits"', '"produces": "report"')
          .replace('"access": "write"', '"access": "read"')
          .replace('"git": { "commit": true },', '');
        const recipe = JSON.stringify({
          name: 'tasting',
          type: 'brew',
          description: 'Brews, tastes through three lenses side by side, opens a pull request.',
          testFirst: false,
          steps: [
            { id: 'brew', brewer: 'cellarman' },
            {
              id: 'taste',
              parallel: TASTERS.map((id) => ({ id, brewer: 'taster', lens: `diff/${id}` })),
              onFindings: { goto: 'brew', maxRounds: 1 },
            },
            { action: 'openPullRequest' },
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
              recipes: [...brewery.recipes, { path: 'recipes/tasting.jsonc', text: recipe }],
              brewers: [...brewery.brewers, { path: 'brewers/taster.md', text: taster }],
              lenses: TASTERS.map((id) => ({ path: `lenses/diff/${id}.md`, text: `The ${id}.` })),
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
                body: 'Three lenses.',
              },
            ],
          },
        });
      };
      const approves = behave.succeedWith({ verdict: 'approve', findings: [] }, 'Nothing here');

      /** The Taster of each step ends the milliseconds after it starts that `ends` says, on the virtual clock. */
      const endingAfter =
        (ends: Readonly<Record<string, number>>): Wrapped =>
        (inner, later) => ({
          progress: inner.progress,
          start: (attempt) => {
            const run = inner.start(attempt);
            const ms = ends[attempt.ref.stepId];
            return ms === undefined
              ? run
              : { ended: later(ms).then(() => run.ended), stop: run.stop };
          },
        });
      /** The Tasters end one after the other, 1 s, 3 s and 5 s after they start. */
      const inTurn = endingAfter({ correctness: 1_000, acceptance: 3_000, security: 5_000 });
      /** Every Taster approves; the cellarman succeeds. */
      const tasted = (attempt: AttemptStart): Behaviour =>
        attempt.ref.stepId === 'brew' ? behave.succeed('Brewed') : approves;

      it('names all three attempts on the line at 120 columns, though each one alone takes most of the width', async () => {
        tasting();
        const { screen, started } = await brewTimed({ seconds: 20 });
        assert.deepStrictEqual(started.map(({ ref }) => ref.stepId).sort(), [
          'acceptance',
          'brew',
          'correctness',
          'security',
        ]);
        const group = screen
          .rewrites()
          .filter((drawn) => /step (?:correctness|acceptance|security)/.test(drawn));
        assert.ok(group.length > 0, screen.rewrites().join('\n'));
        for (const drawn of group) {
          for (const id of TASTERS) assert.match(drawn, new RegExp(`step ${id}`), drawn);
          assert.ok(drawn.length <= 119, drawn);
        }
      });

      it('names all three attempts on the line when the terminal is wide enough for all of them: regression test', async () => {
        tasting();
        const { screen } = await brewTimed({ seconds: 20, columns: 300 });
        const group = screen
          .rewrites()
          .filter((drawn) => /step (?:correctness|acceptance|security)/.test(drawn));
        assert.ok(group.length > 0, screen.rewrites().join('\n'));
        for (const drawn of group) {
          for (const id of TASTERS) assert.match(drawn, new RegExp(`step ${id}`), drawn);
        }
      });

      it('keeps a live line on screen, moving, while the worktree of the last Taster is made', async () => {
        tasting();
        const { seen } = await brewTimed({
          worktree: (step) => (step === 'security' ? 15 : undefined),
          script: tasted,
          runner: inTurn,
        });
        const made = seen.get('worktree security') ?? assert.fail('no worktree was made');
        assert.ok(made.entry !== undefined, 'a live line is on screen between the steps');
        assert.match(made.entry, /ago \/ \S/);
        moved(made, 15_000);
      });

      it('names the pull request, and keeps moving, while the branch is pushed after the last Taster ended', async () => {
        tasting();
        const { code, seen } = await brewTimed({ push: 25, script: tasted, runner: inTurn });
        assert.equal(code, 0, f.lines.join('\n'));
        const pushed = seen.get('push') ?? assert.fail('the branch was not pushed');
        names(pushed, /pull request/i);
        moved(pushed, 25_000);
      });

      it('names the pull request, and keeps moving, while GitHub is slow to open it', async () => {
        tasting();
        const { code, seen } = await brewTimed({
          gh: call('POST', /\/pulls$/, 25),
          script: tasted,
          runner: inTurn,
        });
        assert.equal(code, 0, f.lines.join('\n'));
        const opened =
          seen.get('POST /repos/acme/web/pulls') ?? assert.fail('no pull request opened');
        names(opened, /pull request/i);
        moved(opened, 25_000);
      });

      it('names the cleanup, and keeps moving, while the worktrees of the batch are removed', async () => {
        tasting();
        const { code, seen } = await brewTimed({ clean: 25, script: tasted, runner: inTurn });
        assert.equal(code, 0, f.lines.join('\n'));
        const cleaned = seen.get('clean') ?? assert.fail('the worktrees were not cleaned');
        names(cleaned, /clean/i);
        moved(cleaned, 25_000);
      });

      it('prints every lasting line over a cleared live line, from the first line to the last: regression test', async () => {
        tasting();
        const { code, screen } = await brewTimed({ script: tasted, runner: inTurn });
        assert.equal(code, 0, f.lines.join('\n'));
        assert.ok(screen.rewrites().length > 0, 'a live line was drawn');
        assert.deepStrictEqual(screen.printedOver, []);
        assert.equal(screen.drawn(), undefined);
      });

      describe('in the lines it prints, on a terminal or not (#873)', () => {
        /** Correctness and acceptance end at once; security outlives the tick that started it. */
        const outlived = endingAfter({ security: 3_000 });

        for (const terminal of [false, true]) {
          const where = terminal ? 'on a terminal' : 'off a terminal';

          it(`names every Taster that started, though two ended before the line was said, ${where}`, async () => {
            tasting();
            const { code } = await brewTimed({ terminal, script: tasted, runner: outlived });
            assert.equal(code, 0, f.lines.join('\n'));
            for (const id of TASTERS) {
              assert.ok(
                f.lines.some((line) => line.includes(`step ${id}`)),
                `${id}:\n${f.lines.join('\n')}`,
              );
            }
          });
        }

        it('names every Taster that started, though all three ended within the tick that started them', async () => {
          tasting();
          const { code } = await brewTimed({ terminal: false, script: tasted });
          assert.equal(code, 0, f.lines.join('\n'));
          for (const id of TASTERS) {
            assert.ok(
              f.lines.some((line) => line.includes(`step ${id} started`)),
              `${id}:\n${f.lines.join('\n')}`,
            );
          }
        });
      });

      it('names each attempt of a group once, on the pass after it started: regression test', async () => {
        tasting();
        const { code } = await brewTimed({
          terminal: false,
          script: tasted,
          runner: endingAfter({ security: 3_000 }),
        });
        assert.equal(code, 0, f.lines.join('\n'));
        for (const id of TASTERS) {
          const naming = f.lines.join('\n').split(`step ${id}`).length - 1;
          assert.equal(naming, 1, `${id}:\n${f.lines.join('\n')}`);
        }
      });

      it('names all three attempts on the line at 80 columns', async () => {
        tasting();
        const { screen } = await brewTimed({ seconds: 20, columns: 80 });
        const group = screen
          .rewrites()
          .filter((drawn) => /step (?:correctness|acceptance|security)/.test(drawn));
        assert.ok(group.length > 0, screen.rewrites().join('\n'));
        for (const drawn of group) {
          for (const id of TASTERS) assert.match(drawn, new RegExp(`step ${id}`), drawn);
          assert.ok(drawn.length <= 79, drawn);
        }
      });
    });
  });
});
