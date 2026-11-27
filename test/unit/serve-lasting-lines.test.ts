// The lasting lines `foedrum serve` prints for what a person must know (ADR 0434), through
// runServe: a step ended, a pull request opened, a batch Stuck, the cleanup of a batch and a failed
// read of GitHub, with a live line on a terminal and without one. serve's shell of serve.test.ts over
// a fake screen and a virtual clock, with a runner that ends each attempt itself; no process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';
import { virtualTimeline } from '../helpers/virtual-timeline.ts';

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 56_000,
  cacheWriteTokens: 780,
};
const receipt = {
  complete: true,
  durationMs: 125_000,
  apiDurationMs: 90_000,
  turns: 12,
  edits: 3,
  toolErrors: 0,
  denied: [],
};

/** A runner whose attempts end at once, as `ending` says, with what claude's stream reported. */
const ending = (end: AttemptEnd['ending']): BrewerRunner => ({
  start: () => ({ ended: Promise.resolve({ ending: end, usage, receipt }), stop: () => {} }),
  progress: () => undefined,
});
const brewed = ending({
  kind: 'succeeded',
  output: { status: 'done', summary: 'Brewed', assumptions: [] },
});
const hanging: BrewerRunner = {
  start: () => ({ ended: new Promise(() => {}), stop: () => {} }),
  progress: () => undefined,
};

describe('runServe', () => {
  const f = serveFixture();

  interface Served {
    terminal: boolean;
    runner?: BrewerRunner;
    /** How many seconds of the virtual clock serve runs before it is stopped. */
    seconds?: number;
    overrides?: Parameters<typeof f.shell>[0];
  }

  const served = async ({ terminal, runner = brewed, seconds = 60, overrides }: Served) => {
    const screen = fakeScreen(120);
    const timeline = virtualTimeline(t0, seconds * 1000);
    const shell = f.shell({
      clock: timeline.clock,
      wait: timeline.wait,
      signal: timeline.controller.signal,
      out: (line) => {
        f.lines.push(line);
        screen.print(line);
      },
      runner: () => runner,
      ...(terminal ? { terminal: screen.terminal } : {}),
      ...overrides,
    });
    const code = await runServe(f.setup, shell);
    assert.equal(code, 0, f.lines.join('\n'));
    return { screen };
  };
  const state = () =>
    createCommandLog({ store: f.store, recipes: f.setup.recipes }).state().batches.get('12-1');

  for (const terminal of [true, false]) {
    const mode = terminal ? 'with a live line' : 'without a live line';
    describe(`${mode} on a terminal (ADR 0434)`, () => {
      it(`prints a line for the step that ended, with its time and its tokens, ${mode}`, async () => {
        await served({ terminal });
        assert.equal(state()?.lane.kind, 'on_tap', f.lines.join('\n'));
        const ended = f.lines.filter((line) => line.startsWith('foedrum serve: #12 brew #1 '));
        assert.equal(ended.length, 1, f.lines.join('\n'));
        assert.match(ended[0] ?? '', /\bsucceeded\b/);
        assert.match(ended[0] ?? '', /\b2m 5s\b/);
        assert.match(ended[0] ?? '', /\b1,200 input\b/);
        assert.match(ended[0] ?? '', /\b340 output\b/);
      });

      it(`prints a line for the pull request it opened, with its link, once, ${mode}`, async () => {
        await served({ terminal });
        const [pull] = f.api.pulls;
        assert.ok(pull !== undefined, 'a pull request is opened');
        const link = `https://github.com/acme/web/pull/${pull.number}`;
        const lines = f.lines.filter((line) => line.includes('opened pull request'));
        assert.deepStrictEqual(
          lines.filter((line) => line.startsWith('foedrum serve: #12 opened pull request ')),
          [`foedrum serve: #12 opened pull request ${link}`],
          f.lines.join('\n'),
        );
      });

      it(`prints the cleanup of a batch as its order, its pull request and what it keeps, not in the words of the engine, ${mode}`, async () => {
        const cleaning = async () => ({
          ...fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') }),
          clean: async () => ({
            done: [
              'removed worktree 12-1/brew/1',
              'removed worktree 12-1/brew/2',
              'removed worktree 12-1/openPullRequest/1',
              'deleted branch foedrum/12-1/brew/1',
              'removed batch folder 12-1',
            ],
            kept: [
              'kept branch foedrum/12-1/brew/2: it holds the task tree of batch 12-1, whose pull request is open (ADR 0219)',
            ],
            failed: [],
          }),
        });
        await served({ terminal, overrides: { worktrees: cleaning } });
        const [pull] = f.api.pulls;
        assert.ok(pull !== undefined, 'a pull request is opened');
        assert.deepStrictEqual(
          f.lines.filter((line) => line.includes('cleaned')),
          [
            `foedrum serve: #12 opened pull request #${pull.number}; cleaned its 3 working copies, keeping its last branch in case a check on the pull request fails`,
          ],
        );
      });

      it(`prints a line once for a batch that got Stuck, with what it is Stuck for and each command to type, ${mode}`, async () => {
        const failing = ending({
          kind: 'failed',
          retryable: false,
          reason: 'claude was not found on PATH',
        });
        await served({ terminal, runner: failing, seconds: 120 });
        const lane = state()?.lane;
        assert.equal(lane?.kind, 'stuck', f.lines.join('\n'));
        const lines = f.lines.filter((line) => line.startsWith('foedrum serve: #12 is stuck'));
        assert.equal(lines.length, 1, f.lines.join('\n'));
        assert.match(lines[0] ?? '', /\bat brew\b/);
        const options = lane?.kind === 'stuck' ? lane.options : [];
        assert.ok(options.length > 0, 'a Stuck batch offers a way on');
        for (const option of options) {
          assert.ok((lines[0] ?? '').includes(`foedrum ${option} 12`), lines[0]);
        }
      });
    });
  }

  it('prints no line of a batch that only brews, however many ticks pass: regression test', async () => {
    await served({ terminal: true, runner: hanging, seconds: 120 });
    assert.equal(state()?.lane.kind, 'brewing');
    assert.deepStrictEqual(
      f.lines.filter((line) => /#12 (is stuck|opened|brew #1)/.test(line)),
      [],
      f.lines.join('\n'),
    );
  });

  describe('a lasting line goes over the live line (ADR 0434)', () => {
    it('clears the live line before it prints a line of a batch', async () => {
      const { screen } = await served({ terminal: true });
      const at = screen.events.findIndex((event) =>
        event.startsWith('out: foedrum serve: #12 opened pull request '),
      );
      assert.ok(at > 0, f.lines.join('\n'));
      assert.equal(screen.events[at - 1], 'clear');
      assert.deepStrictEqual(screen.printedOver, []);
    });
  });

  describe('a read of GitHub that fails (ADR 0434)', () => {
    const polling = () => {
      const result = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config({ concurrency: 2 }),
            local: local({ workRoot: f.dir.path }),
          },
        }),
      );
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) =>
          url.pathname.endsWith('/issues')
            ? { status: 500, body: { message: 'a flaky wire' } }
            : undefined,
      });
      return { fetch: github.fetch, runner: () => hanging };
    };
    const told = () => f.lines.filter((line) => line.includes('listing Acme/Brewery'));

    it('says in one line what failed and that the next pass tries again, with no raw error, where a live line is drawn', async () => {
      await served({ terminal: true, seconds: 30, overrides: polling() });
      assert.ok(told().length > 0, f.lines.join('\n'));
      for (const line of told()) {
        assert.match(line, /^foedrum serve: /);
        assert.match(line, /the next pass tries again/);
        assert.ok(!line.includes('a flaky wire'), line);
        assert.ok(!line.includes('GitHub answered'), line);
      }
    });

    it('prints the raw error too where no live line is drawn, and says the next pass tries again', async () => {
      await served({ terminal: false, seconds: 30, overrides: polling() });
      assert.ok(told().length > 0, f.lines.join('\n'));
      for (const line of told()) {
        assert.match(line, /the intake failed listing Acme\/Brewery: .*a flaky wire/);
        assert.match(line, /the next pass tries again/);
      }
    });

    it('still prints the raw error where no live line is drawn: regression test', async () => {
      await served({ terminal: false, seconds: 30, overrides: polling() });
      assert.ok(
        told().some((line) =>
          /^foedrum serve: the intake failed listing Acme\/Brewery: .*a flaky wire/.test(line),
        ),
        f.lines.join('\n'),
      );
    });
  });
});
