// `foedrum serve`'s shell (ADR 0063): it takes the Cellar's lock, opens the store and the state
// branch, each repository's attempt worktrees and the driver, ticks it until Ctrl+C, and closes it
// all again. An in-memory store, fake worktrees, a fake GitHub and a runner that asks for the plan
// and ends each attempt itself; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import {
  formatIntakeNotice,
  formatNotice,
  runServe,
  type ServeShell,
} from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { ExecOptions, ExecProcess } from '../../src/platform/processes.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, config, home, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const issue = JSON.parse(
  readFileSync(new URL('../fixtures/github/issue.json', import.meta.url), 'utf8'),
) as object;
const t0 = new Date('2026-10-17T12:00:00.000Z');

describe('runServe', () => {
  let dir: TempDir;
  let setup: ServeSetup;
  let store: EventStore;
  let closed: number;
  let calls: string[];
  let lines: string[];
  let controller: AbortController;
  let lock: ReturnType<typeof fakeLock>;
  let plans: ClaudeAttemptPlan[];
  // What the shell's pushes pushed, as `<repo> <commit> <branch>`.
  let pushes: string[];

  beforeEach(() => {
    pushes = [];
    dir = makeTempDir('serve');
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot: dir.path }) } }),
    );
    assert.equal(result.kind, 'ready');
    setup = result.kind === 'ready' ? result.setup : assert.fail();
    store = openSqliteEventStore(':memory:');
    const inner = store;
    closed = 0;
    store = {
      ...inner,
      close: () => {
        closed++;
      },
    };
    calls = [];
    lines = [];
    controller = new AbortController();
    lock = fakeLock('cellar');
    plans = [];
    // An order routed to the one-step recipe, as the state branch would have it.
    const log = createCommandLog({ store, recipes: setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label', source: 'label' },
      t0,
    );
  });
  afterEach(() => dir.remove());

  /** A runner whose attempts ask for their plan, then succeed, or fail when it cannot be made. */
  const planningRunner = (plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>) => {
    const runner: BrewerRunner = {
      start: (start) => ({
        ended: plan(start).then(
          (made) => {
            plans.push(made);
            // As the claude runner does, before claude starts.
            writeFileSync(made.settingsFile, '{}');
            const output = { status: 'done', summary: 'Brewed', assumptions: [] };
            return { ending: { kind: 'succeeded', output } } as const;
          },
          (error: Error) => ({
            ending: { kind: 'failed', retryable: false, reason: error.message } as const,
          }),
        ),
        stop: () => {},
      }),
      progress: () => undefined,
    };
    return runner;
  };

  const shell = (overrides: Partial<ServeShell> = {}): ServeShell => ({
    out: (line) => lines.push(line),
    signal: controller.signal,
    clock: () => t0,
    // Stops serve once the batch is on tap, or after 20 ticks.
    wait: async (ms) => {
      calls.push(`wait ${ms}`);
      const lane = createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1')
        ?.lane.kind;
      if (lane === 'on_tap' || calls.length > 40) controller.abort();
    },
    lock: (workRoot, options) => {
      calls.push(`lock ${options.owner} ${options.brewery} ${workRoot === dir.path}`);
      return lock;
    },
    openStore: (path) => {
      calls.push(`store ${path === setup.store}`);
      return store;
    },
    stateBranch: () => ({
      start: async () => {
        calls.push('state branch');
        return { decision: 'ready' };
      },
      flush: async () => ({ kind: 'unchanged' }),
    }),
    worktrees: async (repository) => {
      calls.push(`worktrees ${repository.repo} ${repository.base}`);
      return fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') });
    },
    push: (repository) => ({
      // The task tree is at FAKE_COMMIT, the base elsewhere.
      commit: async (revision) => (revision === 'origin/main' ? 'b'.repeat(40) : FAKE_COMMIT),
      isAncestor: async (commit, of) => commit === of,
      remoteTip: async () => undefined,
      push: async (commit, branch) => {
        pushes.push(`${repository.repo} ${commit} ${branch}`);
      },
    }),
    runner: (claude, plan) => {
      calls.push(`runner ${claude}`);
      return planningRunner(plan);
    },
    // The stout recipe has no check step.
    exec: () => Promise.reject(new Error('no check step runs here')),
    git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
    fetch: fakeFetch([{ status: 200, body: { ...issue, number: 12, body: 'Add a --json flag.' } }])
      .fetch,
    ...overrides,
  });

  const types = () =>
    store
      .eventsAfter(0)
      .map(({ event }) => event.type)
      .filter((type) => type !== 'effect.applied');

  it('pushes the bottle branch and opens one pull request for a recipe that ends with openPullRequest (ADR 0071)', async () => {
    const porter = JSON.stringify({
      name: 'porter',
      description: 'Brews an order in one step and opens its pull request.',
      steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          local: local({ workRoot: dir.path }),
          brewery: {
            recipes: [
              { path: 'recipes/stout.jsonc', text: recipe },
              { path: 'recipes/porter.jsonc', text: porter },
            ],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
        },
      }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail();
    // Serve closes its store at the end; the test reads it after.
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
    const log = createCommandLog({ store, recipes: setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
    });
    assert.equal(await runServe(setup, shell({ fetch: github.fetch })), 0);
    const branch = 'foedrum/acme.brewery/12-1/acme.web';
    assert.deepStrictEqual(pushes, [`acme/web ${FAKE_COMMIT} ${branch}`]);
    assert.deepStrictEqual(
      github.pulls.map(({ repo, head, base, title }) => ({ repo, head, base, title })),
      [{ repo: 'acme/web', head: branch, base: 'main', title: 'Add a --json flag' }],
    );
    assert.match(github.pulls[0]?.body ?? '', /brew: Brewed[\s\S]*\nCloses Acme\/Brewery#12$/);
    const [pull] = github.pulls;
    assert.deepStrictEqual(
      createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1')?.lane,
      { kind: 'on_tap', pullRequests: [`https://github.com/acme/web/pull/${pull?.number}`] },
    );
  });

  it('sets the Cellar up in order, brews the order with its text, and stops on Ctrl+C', async () => {
    assert.equal(await runServe(setup, shell()), 0);
    assert.deepStrictEqual(calls.slice(0, 5), [
      'lock cellar Acme/Brewery true',
      'store true',
      'state branch',
      'worktrees acme/web origin/main',
      'runner /home/brewer/.local/bin/claude',
    ]);
    assert.ok(calls.slice(5).every((call) => call === 'wait 5000'));
    assert.deepStrictEqual(types(), [
      'batch.ordered',
      'batch.recipe_chosen',
      'step.scheduled',
      'step.started',
      'step.finished',
      'batch.on_tap',
    ]);
    const [plan] = plans;
    assert.match(plan?.prompt ?? '', /Add a --json flag\./);
    assert.equal(plan?.call.model, 'claude-haiku-5-5');
    assert.equal(plan?.cwd, join(dir.path, 'acme.web', 'attempts', '12-1', 'brew', '1'));
    assert.equal(plan?.env.npm_config_ignore_scripts, 'true');
    assert.equal(plan?.env.GH_TOKEN, undefined);
    assert.equal(plan?.settingsFile, join(dir.path, 'attempt-settings', '12-1', 'brew', '1.json'));
    assert.deepStrictEqual(
      [lines[0], lines.at(-1)],
      [
        `foedrum serve: brewing for Acme/Brewery in ${dir.path}; Ctrl+C stops it`,
        'foedrum serve: stopped',
      ],
    );
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it('refuses a second Cellar, opening nothing', async () => {
    const running = new DriverRunningError('cellar', 'drivers/cellar.lock', undefined);
    const code = await runServe(
      setup,
      shell({
        lock: () => {
          throw running;
        },
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(lines, [`foedrum serve: ${running.message}`]);
  });

  it('lets the lock go and closes the store when the state branch refuses to start', async () => {
    const code = await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => {
            throw new StateBranchStopError('the branch moved and the store has unpushed events');
          },
          flush: async () => ({ kind: 'unchanged' }),
        }),
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(lines, [
      'foedrum serve: the branch moved and the store has unpushed events',
    ]);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it("stops when a repository's worktrees cannot be opened", async () => {
    const code = await runServe(
      setup,
      shell({
        worktrees: async () => {
          throw new Error('git clone of https://github.com/acme/web.git failed: not found');
        },
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(lines, [
      'foedrum serve: git clone of https://github.com/acme/web.git failed: not found',
    ]);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it('stops when a tick must stop the engine: another engine pushed the state branch', async () => {
    const code = await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            throw new StateBranchStopError('the push was rejected: another engine wrote');
          },
        }),
      }),
    );
    assert.equal(code, 1);
    assert.equal(lines.at(-1), 'foedrum serve: the push was rejected: another engine wrote');
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it("removes an ended batch's attempt settings with its worktrees", async () => {
    assert.equal(await runServe(setup, shell()), 0);
    assert.equal(plans.length, 1);
    assert.equal(existsSync(join(dir.path, 'attempt-settings', '12-1')), false);
  });

  it("gives each brewer its repository's toolchain rules", async () => {
    assert.equal(await runServe(setup, shell()), 0);
    assert.ok(plans[0]?.permissions.allow.includes('Bash(npm test*)'));
  });

  it('keeps ticking after a tick failed for another reason than the state branch', async () => {
    const broken: BrewerRunner = {
      start: () => ({ ended: Promise.reject(new Error('the runner broke')), stop: () => {} }),
      progress: () => undefined,
    };
    assert.equal(await runServe(setup, shell({ runner: () => broken })), 0);
    assert.ok(lines.includes('foedrum serve: a tick failed: the runner broke'), lines.join('\n'));
    // It went on ticking after the failed tick, until it was stopped.
    assert.ok(calls.filter((call) => call === 'wait 5000').length > 1, calls.join('\n'));
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
  });

  it("prints the driver's notices, one line each, and goes on", async () => {
    let flushes = 0;
    await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () =>
            flushes++ === 0 ? { kind: 'failed', reason: 'no network' } : { kind: 'unchanged' },
        }),
      }),
    );
    assert.ok(
      lines.includes('foedrum serve: the state branch was not pushed: no network'),
      lines.join('\n'),
    );
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
  });

  it('prints a notice with control characters escaped, since a model may have written it', async () => {
    let flushes = 0;
    await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () =>
            flushes++ === 0
              ? { kind: 'failed', reason: 'hook said \u001b[2Jhi' }
              : { kind: 'unchanged' },
        }),
      }),
    );
    assert.ok(
      lines.includes('foedrum serve: the state branch was not pushed: hook said \\u001b[2Jhi'),
      lines.join('\n'),
    );
  });

  describe('a recipe with a check step (ADR 0069)', () => {
    const outsideSandbox =
      'foedrum serve: check steps run outside the OS sandbox: their commands can run code a brewer wrote, with network and home-folder access (ADR 0069)';

    it('says at its start, once, that check steps run outside the OS sandbox', async () => {
      assert.equal(setup.sandbox, true);
      assert.equal(await runServe(setup, shell()), 0);
      assert.equal(lines[1], outsideSandbox);
      assert.equal(lines.filter((line) => line === outsideSandbox).length, 1);
    });

    it('says nothing of it when nothing runs sandboxed', async () => {
      assert.equal(await runServe({ ...setup, sandbox: false }, shell()), 0);
      assert.ok(!lines.includes(outsideSandbox), lines.join('\n'));
    });

    it('says nothing of it when no recipe has a check step', async () => {
      const files = serveInputs().files;
      const stoutOnly = serveSetup(
        serveInputs({
          files: {
            ...files,
            local: local({ workRoot: dir.path }),
            brewery: { ...files.brewery, recipes: files.brewery.recipes.slice(0, 1) },
          },
        }),
      );
      assert.ok(stoutOnly.kind === 'ready');
      assert.equal(await runServe(stoutOnly.setup, shell()), 0);
      assert.ok(!lines.includes(outsideSandbox), lines.join('\n'));
    });

    type Call = { file: string; args: readonly string[]; options: ExecOptions };
    /** Serve with a brewer that succeeds and a process runner that answers each check with `code`. */
    const brewWithChecks = async (code: number) => {
      const log = createCommandLog({ store, recipes: setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const checks: Call[] = [];
      const exec: ExecProcess = async (file, args, options) => {
        checks.push({ file, args, options });
        const output = code === 0 ? 'ok 1\n' : 'not ok 1\n';
        return { exitCode: code, stdout: output, stderr: '', output };
      };
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const code_ = await runServe(
        setup,
        shell({
          runner: () => succeeding,
          exec,
          wait: async () => {
            calls.push('wait');
            const lane = log.state().batches.get('13-1')?.lane.kind;
            if (lane === 'on_tap' || lane === 'stuck' || calls.length > 40) controller.abort();
          },
        }),
      );
      assert.equal(code_, 0);
      const events = store
        .eventsAfter(0)
        .map(({ event }) => event)
        .filter((event) => 'batchId' in event && event.batchId === '13-1');
      return { checks, events, batch: log.state().batches.get('13-1') };
    };
    const worktreeOf = (attempt: number) =>
      join(dir.path, 'acme.web', 'attempts', '13-1', 'green', String(attempt));

    it("runs the repository's test command in the check's worktree, and the batch goes on tap", async () => {
      const { checks, events, batch } = await brewWithChecks(0);
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(
        checks.map(({ file, args, options }) => [file, args, options.cwd, options.shell]),
        [['npm test', [], worktreeOf(1), true]],
      );
      // The brewers' minimal environment and nothing else: no GitHub token under any name, and
      // no npm lifecycle scripts (ADR 0063).
      const env = checks[0]?.options.env ?? {};
      assert.deepStrictEqual(env, {
        PATH: '/usr/bin',
        HOME: home,
        npm_config_ignore_scripts: 'true',
      });
      assert.ok(!Object.values(env).includes(setup.github.token));
      const finished = events.filter(
        (event) => event.type === 'step.finished' && event.stepId === 'green',
      );
      assert.deepStrictEqual(finished, [
        {
          type: 'step.finished',
          batchId: '13-1',
          stepId: 'green',
          attempt: 1,
          outcome: { kind: 'succeeded', output: null },
          readings: [
            { result: 'exited', check: 'test', command: 'npm test', exitCode: 0, tail: 'ok 1\n' },
          ],
        },
      ]);
    });

    it('sends the batch back along onFail when the test fails, then makes it Stuck', async () => {
      const { checks, events, batch } = await brewWithChecks(1);
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === 'step.scheduled')
          .map((event) => [event.stepId, event.attempt, event.route]),
        [
          ['brew', 1, undefined],
          ['green', 1, undefined],
          ['brew', 2, { from: 'green', why: 'failed' }],
          ['green', 2, undefined],
        ],
      );
      assert.deepStrictEqual(
        checks.map(({ options }) => options.cwd),
        [worktreeOf(1), worktreeOf(2)],
      );
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'attempts_exhausted',
        stepId: 'green',
        attempts: 2,
        lastReason: 'the check "test" (npm test) failed with exit code 1',
      });
    });
  });

  describe('test-first recipes (ADR 0078)', () => {
    // The Gauger commits failing tests, the red proof reads them, the cellarman keeps them.
    const nip = JSON.stringify({
      name: 'nip',
      description: 'Proves the tests red, then brews.',
      steps: [
        { id: 'gauge', brewer: 'gauger' },
        { id: 'red', check: 'test', expect: 'fail', of: 'gauge' },
        { id: 'implement', brewer: 'cellarman' },
      ],
    });
    const guarded = brewer.replace(
      '"maxAttempts": 1',
      '"maxAttempts": 1,\n  "guards": ["testsUnchanged"]',
    );
    const gauger = brewer.replace('"name": "cellarman"', '"name": "gauger"');
    const testFirstSetup = (web: Record<string, unknown>) => {
      const files = serveInputs().files;
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({}, web),
            local: local({ workRoot: dir.path }),
            brewery: {
              recipes: [{ path: 'recipes/nip.jsonc', text: nip }],
              brewers: [
                { path: 'brewers/cellarman.md', text: guarded },
                { path: 'brewers/gauger.md', text: gauger },
              ],
            },
          },
        }),
      );
      assert.ok(result.kind === 'ready', JSON.stringify(result));
      return result.setup;
    };
    const tap =
      "TAP version 13\nnot ok 1 - adds two numbers\n  ---\n  error: 'not implemented'\n  ...\n1..1\n";
    const gaugeDiff =
      "diff --git a/add.test.mjs b/add.test.mjs\n--- /dev/null\n+++ b/add.test.mjs\n@@ -0,0 +1 @@\n+test('adds two numbers', () => assert.equal(add(1, 2), 3));\n";

    /** Serve brewing batch 14-1 with the nip recipe: what the brewers, the checks and git saw. */
    const brewTestFirst = async (testFirst: ServeSetup) => {
      const log = createCommandLog({ store, recipes: testFirst.recipes });
      log.issue({ kind: 'order', batchId: '14-1', order: { issue: 14 } }, t0);
      const route = { kind: 'route', batchId: '14-1', recipe: 'nip', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const brewed: string[] = [];
      const succeeding: BrewerRunner = {
        start: ({ ref }) => {
          // Batch 12-1 of beforeEach brews too.
          if (ref.batchId === '14-1') brewed.push(ref.stepId);
          const output = { status: 'done', summary: 'Brewed' };
          return {
            ended: Promise.resolve({ ending: { kind: 'succeeded', output } }),
            stop: () => {},
          };
        },
        progress: () => undefined,
      };
      const checks: string[] = [];
      const exec: ExecProcess = async (file) => {
        checks.push(file);
        return { exitCode: 1, stdout: tap, stderr: '', output: tap };
      };
      const diffs: string[] = [];
      const code = await runServe(
        testFirst,
        shell({
          runner: () => succeeding,
          exec,
          git: async (_cwd, args) => {
            const range = args.slice(-3, -1).join(' ');
            diffs.push(range);
            return { code: 0, stdout: range.endsWith('HEAD') ? '' : gaugeDiff, stderr: '' };
          },
          wait: async () => {
            calls.push('wait');
            const lane = log.state().batches.get('14-1')?.lane.kind;
            if (lane === 'on_tap' || lane === 'stuck' || calls.length > 40) controller.abort();
          },
        }),
      );
      assert.equal(code, 0);
      return { brewed, checks, diffs, batch: log.state().batches.get('14-1') };
    };

    it('makes a batch Stuck at its start, before any brewer runs, when the repository has no test report', async () => {
      const { brewed, checks, batch } = await brewTestFirst(testFirstSetup({}));
      assert.deepStrictEqual([brewed, checks], [[], []]);
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'blocked',
        stepId: 'gauge',
        blockerKind: 'environment',
        summary:
          'recipe nip proves its tests red, which needs the test report of acme/web: add "testReport" to its entry in foedrum.jsonc, { "format": "tap" } or { "format": "junit", "path": "<file>" } (ADR 0017)',
      });
    });

    it("proves the Gauger's tests red from the test report and guards them, through serve's git", async () => {
      const { brewed, checks, diffs, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }),
      );
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual([brewed, checks], [['gauge', 'implement'], ['npm test']]);
      // The red proof reads the Gauger's commits; the guard reads them and the cellarman's own.
      const gaugeRange = /^[0-9a-f]{40} refs\/heads\/foedrum\/14-1\/gauge\/1$/;
      assert.equal(diffs.length, 3);
      assert.match(diffs[0] ?? '', gaugeRange);
      assert.match(diffs[1] ?? '', gaugeRange);
      assert.match(diffs[2] ?? '', /^[0-9a-f]{40} HEAD$/);
    });
  });

  it('does not tick once it was stopped before it started', async () => {
    controller.abort();
    assert.equal(await runServe(setup, shell()), 0);
    assert.deepStrictEqual(types().slice(-1), ['step.scheduled']);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  describe('the intake in its loop (ADR 0068)', () => {
    const target = { alias: 'web', intake: { labels: ['foedrum'] } };
    const intakeSetup = (
      fields: Record<string, unknown> = {},
      web: Record<string, unknown> = {},
    ) => {
      const result = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config(fields, web),
            local: local({ workRoot: dir.path }),
          },
        }),
      );
      assert.equal(
        result.kind,
        'ready',
        result.kind === 'refused' ? result.problems.join('\n') : '',
      );
      return result.kind === 'ready' ? result.setup : assert.fail();
    };
    const brewerySpelled = 'Acme/Brewery';
    const listingOf = (repo: string) => (request: string) =>
      request.startsWith(`GET /repos/${repo}/issues?`);
    let now: number;
    beforeEach(() => {
      now = t0.getTime();
    });
    const state = () => createCommandLog({ store, recipes: setup.recipes }).state();
    const lane = (batchId: string) => state().batches.get(batchId)?.lane.kind;
    /** A clock that moves `stepMs` at every wait; serve stops once `stop` holds, or at 200 waits. */
    const ticking = (stop: () => boolean, stepMs = 5000) => ({
      clock: () => new Date(now),
      wait: async () => {
        calls.push('wait');
        now += stepMs;
        // Lets the pass underway go on between ticks, as the real wait does.
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (stop() || calls.length > 200) controller.abort();
      },
    });
    /** A store with no order in it, which serve closes as it closes the one of beforeEach. */
    const empty = (): EventStore => {
      const inner = openSqliteEventStore(':memory:');
      return {
        ...inner,
        close: () => {
          closed++;
        },
      };
    };
    const hanging: BrewerRunner = {
      start: () => ({ ended: new Promise(() => {}), stop: () => {} }),
      progress: () => undefined,
    };

    it('orders and routes a labelled Brewery issue and a claimed target issue, marks the claim and releases it', async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2 }, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 12, labels: ['recipe:stout'], author: 'ann', body: 'Add a --json flag.' },
          ],
          'acme/web': [
            {
              number: 7,
              labels: ['foedrum', 'recipe:stout'],
              author: 'ann',
              body: 'Add a dark theme.',
            },
          ],
        },
      });
      const done = () =>
        lane('12-1') === 'on_tap' &&
        lane('web-7') === 'on_tap' &&
        github.created.length === 1 &&
        github.refs.size === 0 &&
        github.comments.get('acme/web#7')?.length === 2;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(done) })), 0);
      assert.ok(done(), lines.join('\n'));
      for (const batchId of ['12-1', 'web-7']) {
        assert.deepStrictEqual(state().batches.get(batchId)?.recipe, {
          name: 'stout',
          reason: 'the label recipe:stout',
          source: 'label',
        });
      }
      const claimed = github.issue('acme/web', 7);
      assert.deepStrictEqual(claimed?.assignees, ['ann']);
      // foedrum:claimed was added with the claim and removed with its release.
      assert.deepStrictEqual(claimed?.labels, ['foedrum', 'recipe:stout']);
      assert.ok(github.requests.includes('GET /user'));
      for (const line of [
        `ordered ${brewerySpelled}#12 as batch 12-1`,
        'ordered acme/web#7 as batch web-7',
        'routed batch 12-1 to the recipe stout',
        'routed batch web-7 to the recipe stout',
      ]) {
        assert.ok(lines.includes(`foedrum serve: ${line}`), `${line}\n${lines.join('\n')}`);
      }
      assert.deepStrictEqual(
        plans.map(({ prompt }) => /Add a (--json flag|dark theme)/.exec(prompt)?.[0]).sort(),
        ['Add a --json flag', 'Add a dark theme'],
      );
    });

    it('polls every pollEvery, not at every tick, and reads no login without a target intake', async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      const stop = () => now >= t0.getTime() + 125_000;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0, 60 and 120 seconds.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
      assert.equal(github.requests.includes('GET /user'), false);
    });

    it("polls at foedrum.jsonc's pollEvery", async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2, pollEvery: '2m' });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      const stop = () => now >= t0.getTime() + 245_000;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0 and 120 seconds, and 240.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
    });

    it("times GitHub's rate-limit pause on serve's clock, not the machine's", async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2 });
      // Years ahead of the machine's clock: a pause timed by Date.now would last its hour at most.
      const start = Date.parse('2031-01-01T00:00:00.000Z');
      now = start;
      let first = true;
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => {
          if (!url.pathname.endsWith('/issues') || !first) return undefined;
          first = false;
          const reset = String(Math.floor((start + 180_000) / 1000));
          return {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
          };
        },
      });
      const stop = () => now >= start + 250_000;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // Refused at 0; asked again at 180 and 240 seconds of serve's clock.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
    });

    it("starts no pass while GitHub's rate limit pauses the token (ADR 0052)", async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2 });
      let first = true;
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => {
          if (!url.pathname.endsWith('/issues') || !first) return undefined;
          first = false;
          const reset = String(Math.floor((t0.getTime() + 180_000) / 1000));
          return {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
          };
        },
      });
      const stop = () => now >= t0.getTime() + 250_000;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0, refused; then not until the reset at 180 seconds, and again at 240.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
      assert.equal(lines.filter((line) => /rate limit/.test(line)).length, 1, lines.join('\n'));
    });

    it('ticks on while a slow pass is underway, and the batch leases stay alive', {
      timeout: 10_000,
    }, async () => {
      setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      // The Brewery's listing answers only once the test lets it, three ticks after it was asked.
      let release = (): void => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waits = () => calls.filter((call) => call === 'wait').length;
      let listedAt: number | undefined;
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (listingOf(brewerySpelled)(`GET ${url.pathname}${url.search}`)) {
          listedAt ??= waits();
          await released;
        }
        return github.fetch(input, init);
      }) as typeof globalThis.fetch;
      let lease: ReturnType<EventStore['batchLeases']>[number] | undefined;
      let releasedAt: number | undefined;
      const stop = () => {
        if (listedAt !== undefined && releasedAt === undefined && waits() - listedAt >= 3) {
          // Three minutes of ticks into the pass: past half the lease, so only a heartbeat keeps it.
          lease = store.batchLeases(new Date(now)).find(({ batchId }) => batchId === '12-1');
          releasedAt = waits();
          release();
        }
        return releasedAt !== undefined && waits() > releasedAt + 1;
      };
      const code = await runServe(
        setup,
        shell({ fetch, runner: () => hanging, ...ticking(stop, 60_000) }),
      );
      assert.equal(code, 0);
      assert.ok(releasedAt !== undefined, lines.join('\n'));
      assert.equal(lease?.owner, 'cellar');
      assert.ok((lease?.expiresAt.getTime() ?? 0) > now - 60_000, 'renewed during the pass');
      assert.deepStrictEqual(
        lines.filter((line) => line.includes('the intake failed')),
        [],
      );
    });

    it('waits for the pass underway before it stops', async () => {
      setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => (url.pathname.endsWith('/issues') ? 'hang' : undefined),
      });
      const stop = () => github.requests.some(listingOf(brewerySpelled));
      await runServe(
        setup,
        shell({
          fetch: github.fetch,
          runner: () => hanging,
          intakeDeadlineMs: 40,
          ...ticking(stop),
        }),
      );
      const late = lines.findIndex((line) => /the intake failed the pass/.test(line));
      assert.ok(late !== -1 && late < lines.indexOf('foedrum serve: stopped'), lines.join('\n'));
      assert.deepStrictEqual([lock.held, closed], [false, 1]);
    });

    it("orders up to foedrum.jsonc's concurrency in one pass", async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2 });
      // A recipe the Brewery lacks: both batches stay Ordered, holding their places.
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [12, 13, 14].map((number) => ({
            number,
            labels: ['recipe:pint'],
            author: 'ann',
          })),
        },
      });
      const stop = () => calls.filter((call) => call === 'wait').length >= 3;
      await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop, 0) }));
      assert.deepStrictEqual([...state().batches.keys()], ['12-1', '13-1']);
    });

    it('releases the claim of a claimed batch the store has, though no repository has an intake any more', async () => {
      store = empty();
      setup = intakeSetup();
      const log = createCommandLog({ store, recipes: setup.recipes });
      log.issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      log.issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' }, t0);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: { 'acme/web': [{ number: 7, labels: ['foedrum:claimed'], author: 'ann' }] },
      });
      const released = () => github.comments.get('acme/web#7')?.length === 1;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(released) })), 0);
      assert.ok(released(), lines.join('\n'));
      assert.ok(github.requests.includes('GET /user'));
      assert.deepStrictEqual(github.issue('acme/web', 7)?.labels, []);
    });

    it("stops when it cannot read the token's login for a target intake", async () => {
      setup = intakeSetup({}, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) =>
          url.pathname === '/user'
            ? { status: 401, body: { message: 'Bad credentials' } }
            : undefined,
      });
      assert.equal(await runServe(setup, shell({ fetch: github.fetch })), 1);
      assert.equal(
        lines.at(-1),
        'foedrum serve: GitHub answered 401 to the login of the token: Bad credentials',
      );
      assert.deepStrictEqual([lock.held, closed], [false, 1]);
    });
  });
});

describe('formatNotice', () => {
  const key = { batchId: '12-1', stepId: 'brew', attempt: 1, effect: 'comment' };
  const command = { kind: 'expire', batchId: '12-1', stepId: 'brew', attempt: 1 } as const;
  it('says what happened in one line for each notice', () => {
    assert.deepStrictEqual(
      [
        formatNotice({ kind: 'refused', command, reason: 'the batch is on tap' }),
        formatNotice({ kind: 'command_failed', command, error: new Error('disk full') }),
        formatNotice({ kind: 'flush_failed', reason: 'no network' }),
        formatNotice({ kind: 'flush_overdue', since: t0 }),
        formatNotice({ kind: 'tick_failed', error: 'boom' }),
        formatNotice({
          kind: 'batch_lost',
          batchId: '12-1',
          holder: { batchId: '12-1', owner: 'session-1', expiresAt: t0 },
        }),
        formatNotice({ kind: 'effect_failed', key, error: new Error('GitHub answered 502') }),
        formatNotice({
          kind: 'cleaned',
          batchId: '12-1',
          report: {
            done: ['removed worktree 12-1/brew/1'],
            kept: [],
            failed: ['could not clean x: busy'],
          },
        }),
        formatNotice({
          kind: 'cleaned',
          batchId: '12-1',
          report: { done: [], kept: [], failed: [] },
        }),
      ],
      [
        'expire of batch 12-1 was refused: the batch is on tap',
        'expire of batch 12-1 failed: disk full',
        'the state branch was not pushed: no network',
        'the state branch has not been pushed since 2026-10-17T12:00:00.000Z',
        'a tick failed: boom',
        'batch 12-1 is driven by session-1 now',
        `the effect ${JSON.stringify(['12-1', 'brew', 1, 'comment'])} failed: GitHub answered 502`,
        'cleaned batch 12-1: removed worktree 12-1/brew/1; could not clean x: busy',
        'cleaned batch 12-1: nothing to remove',
      ],
    );
  });
});

describe('formatIntakeNotice', () => {
  it('says what the intake did or could not do in one line for each notice (ADR 0068)', () => {
    const command = { kind: 'order', batchId: '12-1', order: { issue: 12 } } as const;
    assert.deepStrictEqual(
      [
        formatIntakeNotice({ kind: 'ordered', repo: 'acme/web', issue: 7, batchId: 'web-7' }),
        formatIntakeNotice({ kind: 'routed', batchId: 'web-7', recipe: 'stout' }),
        formatIntakeNotice({ kind: 'unrouted', batchId: '12-1', reason: 'no recipe pint' }),
        formatIntakeNotice({ kind: 'taken', repo: 'acme/web', issue: 3, by: 'bob/brewery' }),
        formatIntakeNotice({ kind: 'taken', repo: 'acme/web', issue: 4, by: undefined }),
        formatIntakeNotice({ kind: 'refused', command, reason: 'batch 12-1 exists' }),
        formatIntakeNotice({ kind: 'failed', what: 'listing acme/web', error: new Error('502') }),
      ],
      [
        'ordered acme/web#7 as batch web-7',
        'routed batch web-7 to the recipe stout',
        'batch 12-1 is not routed: no recipe pint',
        'acme/web#3 is claimed by bob/brewery',
        'acme/web#4 is claimed by a ref whose record cannot be read',
        'order of batch 12-1 was refused: batch 12-1 exists',
        'the intake failed listing acme/web: 502',
      ],
    );
  });
});
