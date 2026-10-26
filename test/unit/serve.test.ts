// `foedrum serve`'s shell (ADR 0063): it takes the Cellar's lock, opens the store and the state
// branch, each repository's attempt worktrees and the driver, ticks it until Ctrl+C, and closes it
// all again. An in-memory store, fake worktrees, a fake GitHub and a runner that asks for the plan
// and ends each attempt itself; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import {
  formatIntakeNotice,
  formatNotice,
  type LiveTerminal,
  runServe,
  type ServeShell,
} from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { WorktreeMerge } from '../../src/engine/base-merge.ts';
import { brewerForcedEnv } from '../../src/engine/brewer-env.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { ExecOptions, ExecProcess } from '../../src/platform/processes.ts';
import type { Event } from '../../src/schemas/events.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi, type Instead } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import {
  FAKE_COMMIT,
  type FakeWorktrees,
  fakeWorktreeMerge,
  fakeWorktrees,
} from '../helpers/fake-worktrees.ts';
import {
  brewer,
  clone,
  config,
  home,
  local,
  recipe,
  serveInputs,
} from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

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
  /** The Brewery's issue 12 with its text, where the status comment goes too (ADR 0072). */
  let api: FakeGitHubApi;
  // What the shell's pushes pushed, as `<repo> <commit> <branch>`.
  let pushes: string[];
  // The waits that saw the batch on tap.
  let onTapWaits: number;

  beforeEach(() => {
    pushes = [];
    onTapWaits = 0;
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
    api = fakeGitHubApi({
      login: 'ann',
      issues: {
        // Each batch opens its pull request with its order's title (ADR 0071).
        'acme/brewery': [12, 13, 14].map((number) => ({
          number,
          labels: [],
          author: 'ann',
          title: 'Add a --json flag',
          body: 'Add a --json flag.',
        })),
      },
    });
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

  // GitHub through a fake gh over a fake fetch (ADR 0073).
  const shell = ({
    fetch = api.fetch,
    ...overrides
  }: Partial<ServeShell> & { fetch?: typeof globalThis.fetch } = {}): ServeShell => ({
    out: (line) => lines.push(line),
    signal: controller.signal,
    clock: () => t0,
    // Stops serve one tick after the batch went on tap, or after 20 ticks: the openPullRequest
    // action ends it after the drive, and the next tick's drive cleans it (ADR 0037).
    wait: async (ms) => {
      calls.push(`wait ${ms}`);
      const lane = createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1')
        ?.lane.kind;
      if (lane === 'on_tap') onTapWaits++;
      if (onTapWaits > 1 || calls.length > 40) controller.abort();
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
    merge: () => fakeWorktreeMerge(),
    push: (repository) => ({
      // The task tree is at FAKE_COMMIT, the base elsewhere.
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit, of) => commit === of,
      remoteTip: async () => undefined,
      push: async (commit, branch) => {
        pushes.push(`${repository.repo} ${commit} ${branch}`);
      },
      secretScan: async () => [],
      touchedFiles: async () => [],
    }),
    runner: (claude, plan) => {
      calls.push(`runner ${claude}`);
      return planningRunner(plan);
    },
    // The stout recipe has no check step.
    exec: () => Promise.reject(new Error('no check step runs here')),
    setup: () => Promise.reject(new Error('no repository setup runs here')),
    gh: ghOver(fetch).exec,
    git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
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

  it("records the sensitive files the push of a repository's pull request touches (ADR 0201)", async () => {
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
          config: config({}, { sensitivePaths: ['src/auth/**'] }),
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
    const push = (repository: { repo: string }) => ({
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit: string, of: string) => commit === of,
      remoteTip: async () => undefined,
      push: async (commit: string, branch: string) => {
        pushes.push(`${repository.repo} ${commit} ${branch}`);
      },
      secretScan: async () => [],
      touchedFiles: async () => ['README.md', 'src/auth/login.ts'],
    });
    assert.equal(await runServe(setup, shell({ fetch: github.fetch, push })), 0);
    const pushed = store.findEffect({ batchId: '12-1', effect: 'push' }) ?? assert.fail('no push');
    assert.deepStrictEqual((pushed.result as { sensitive?: unknown }).sensitive, {
      count: 1,
      files: ['src/auth/login.ts'],
    });
  });

  /**
   * Brews 12-1 with the porter recipe until its pull request is open, with a base that moved and a
   * merge-tree that conflicts (ADR 0198), on a git that records what it is asked and answers nothing.
   * With `passed`, the merge-tree is clean and every check on the head passed, until the merge brief
   * is posted (ADR 0225).
   */
  const brewWithMovedBase = async (passed = false) => {
    const porter = JSON.stringify({
      name: 'porter',
      description: 'Brews an order in one step and opens its pull request.',
      // With `passed`, a red proof its `when` skips, which the brief names (ADR 0225).
      steps: [
        { id: 'brew', brewer: 'cellarman' },
        ...(passed
          ? [{ id: 'red', check: 'test', expect: 'fail', of: 'brew', when: 'recipe.testFirst' }]
          : []),
        { action: 'openPullRequest' },
      ],
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
    const ready = result.kind === 'ready' ? result.setup : assert.fail();
    // A pass at every tick, so one sees the batch on tap.
    setup = { ...ready, intake: { ...ready.intake, pollEveryMs: 0 } };
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
    const log = createCommandLog({ store, recipes: setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    // The head of the pull request and the one check on it, which passed (ADR 0213).
    const checks = (_method: string, url: URL): Instead | undefined => {
      if (!passed) return undefined;
      if (/^\/repos\/acme\/web\/pulls\/\d+$/.test(url.pathname)) {
        return { status: 200, body: { head: { sha: FAKE_COMMIT } } };
      }
      if (url.pathname.endsWith(`/commits/${FAKE_COMMIT}/check-runs`)) {
        const run = { name: 'ci', status: 'completed', conclusion: 'success', html_url: null };
        return { status: 200, body: { total_count: 1, check_runs: [run] } };
      }
      if (url.pathname.endsWith(`/commits/${FAKE_COMMIT}/status`)) {
        return { status: 200, body: { statuses: [] } };
      }
      return undefined;
    };
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
      instead: checks,
    });
    const merged: string[] = [];
    // The pull request's comments that carry the merge brief's marker.
    const briefComments = () =>
      [...github.comments.entries()].flatMap(([key, comments]) =>
        comments.filter(({ body }) => body.includes('brief.1')).map(({ body }) => ({ key, body })),
      );
    // The pull request's comments that carry the conflict's marker.
    const conflictComments = () =>
      [...github.comments.entries()].flatMap(([key, comments]) =>
        comments
          .filter(({ body }) => body.includes('base_conflict.1'))
          .map(({ body }) => ({ key, body })),
      );
    const asked: string[] = [];
    let waits = 0;
    const code = await runServe(
      setup,
      shell({
        fetch: github.fetch,
        wait: async () => {
          waits++;
          // A person retitles the pull request once it is open: the brief reads its title.
          const [opened] = github.pulls;
          if (passed && opened !== undefined) opened.title = 'Add a --json flag, retitled';
          const done = passed ? briefComments() : conflictComments();
          if (done.length > 0 || waits > 40) controller.abort();
        },
        git: async (_cwd, args) => {
          asked.push(args.join(' '));
          throw new Error('no red proof or guarded step runs here');
        },
        // The bottle branch holds what was pushed; the base moved to 'b…' since.
        push: (repository) => ({
          commit: async () => FAKE_COMMIT,
          baseTip: async () => 'b'.repeat(40),
          isAncestor: async (commit, of) => commit === of,
          remoteTip: async () => (pushes.length > 0 ? FAKE_COMMIT : undefined),
          push: async (commit, branch) => {
            pushes.push(`${repository.repo} ${commit} ${branch}`);
          },
          secretScan: async () => [],
          touchedFiles: async () => [],
        }),
        mergeTree: () => async (head, tip) => {
          merged.push(`${head} ${tip}`);
          return passed ? { kind: 'clean' } : { kind: 'conflicts', files: ['src/cli.ts'] };
        },
      }),
    );
    const [pull] = github.pulls;
    const baseChecks = createCommandLog({ store, recipes: setup.recipes })
      .state()
      .batches.get('12-1')?.baseChecks;
    return { code, merged, pull, baseChecks, conflictComments, briefComments, asked };
  };

  it("checks an open pull request against its base's moved tip and comments the conflict on it (ADR 0198)", async () => {
    const { code, merged, pull, baseChecks, conflictComments, asked } = await brewWithMovedBase();
    assert.equal(code, 0);
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(merged, [`${FAKE_COMMIT} ${'b'.repeat(40)}`]);
    const url = `https://github.com/acme/web/pull/${pull?.number}`;
    assert.deepStrictEqual(baseChecks, [
      { pullRequest: url, branch: 'main', tip: 'b'.repeat(40), conflicts: ['src/cli.ts'] },
    ]);
    const [comment] = conflictComments();
    assert.ok(comment, lines.join('\n'));
    assert.equal(comment?.key, `acme/web#${pull?.number}`);
    assert.match(comment?.body ?? '', /src\/cli\.ts/);
  });

  it('posts the merge brief on a pull request whose checks passed on its head (ADR 0225, regression test)', async () => {
    const { code, pull, briefComments } = await brewWithMovedBase(true);
    assert.equal(code, 0);
    const [brief] = briefComments();
    assert.ok(brief, lines.join(String.fromCodePoint(0x0a)));
    assert.equal(brief?.key, `acme/web#${pull?.number}`);
    assert.match(brief?.body ?? '', /^### Merge\? Add a --json flag, retitled @ `/);
    assert.match(brief?.body ?? '', /- ✅ ci \(success\)/);
    assert.match(
      brief?.body ?? '',
      /- Red proof `red`: not run: its when "recipe\.testFirst" was false\./,
    );
  });

  describe('a usage window per family (review of #555, ADR 0215)', () => {
    /** Serves the Brewery with `models` for its models.jsonc, the Opus window closed all day. */
    const servedWhileOpusClosed = async (models: string) => {
      const result = serveSetup(
        serveInputs({
          files: { ...serveInputs().files, local: local({ workRoot: dir.path }), models },
        }),
      );
      setup = result.kind === 'ready' ? result.setup : assert.fail();
      store.withTransaction((tx) =>
        tx.append({
          type: 'usage.window_closed',
          limit: 'Opus',
          resets: '11:55pm',
          reopensAt: '2026-10-18T00:00:00.000Z',
          read: true,
        }),
      );
      assert.equal(await runServe(setup, shell()), 0);
    };

    it('starts the cellarman models.jsonc swaps to a Sonnet alias, though its own alias runs Opus', async () => {
      await servedWhileOpusClosed(
        JSON.stringify({
          models: { quick: 'claude-opus-5-5', middle: 'claude-sonnet-5-5' },
          brewers: { cellarman: 'middle' },
        }),
      );
      assert.equal(plans.length, 1);
    });

    it('holds the cellarman on Opus', async () => {
      await servedWhileOpusClosed(JSON.stringify({ models: { quick: 'claude-opus-5-5' } }));
      assert.deepStrictEqual(plans, []);
    });
  });

  it('keeps its plain lines and never touches a terminal its shell holds (ADR 0174)', async () => {
    const touched: string[] = [];
    const terminal: LiveTerminal = {
      columns: () => {
        touched.push('columns');
        return 80;
      },
      onResize: () => {
        touched.push('onResize');
        return () => {};
      },
      clear: () => {
        touched.push('clear');
      },
      rewrite: () => {
        touched.push('rewrite');
      },
    };
    assert.equal(await runServe(setup, shell({ terminal })), 0);
    assert.deepStrictEqual(touched, []);
    assert.ok(lines.length > 0, 'serve printed its lines');
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
      // The openPullRequest action (ADR 0071, ADR 0084).
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
    // The cellarman produces commits: they are counted on its branch in the local clone its
    // worktree was added to, which the push takes too (ADR 0074, review of #208).
    assert.deepStrictEqual(plan?.commits, { clone, branch: 'foedrum/12-1/brew/1' });
    assert.deepStrictEqual(
      [lines[0], lines.at(-1)],
      [
        `foedrum serve: brewing for Acme/Brewery in ${dir.path}; Ctrl+C stops it`,
        'foedrum serve: stopped',
      ],
    );
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
    // One status comment on the order's issue, by the token's login, followed up to on tap.
    const status = api.comments.get('acme/brewery#12') ?? [];
    assert.equal(status.length, 1, 'one status comment');
    assert.equal(status[0]?.author, 'ann');
    assert.match(status[0]?.body ?? '', /On tap/);
    assert.match(status[0]?.body ?? '', /`brew`/);
    // The batch goes on tap within the first tick, so whether an edit came first is the timing's.
    assert.match(status[0]?.body ?? '', /<!-- foedrum:\["12-1","status\.\d+"\] -->$/);
  });

  it('holds the machine awake only while an attempt runs, and lets the hold go when it stops (ADR 0195)', async () => {
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push('started'),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    assert.equal(await runServe(setup, shell({ awake })), 0);
    // The brew step's attempt; the openPullRequest action is no attempt.
    assert.deepStrictEqual(held, ['started', 'ended', 'released']);
  });

  describe('the hold when an attempt fails to start or end (ADR 0195)', () => {
    const recording = () => {
      const held: string[] = [];
      const awake = {
        attemptStarted: () => held.push('started'),
        attemptEnded: () => held.push('ended'),
        release: () => held.push('released'),
      };
      return { held, awake };
    };
    /** Every start is matched by its end before the next, and the hold is let go last. */
    const balanced = (held: readonly string[]) => {
      assert.ok(held.length >= 3, held.join(', '));
      assert.equal(held.at(-1), 'released');
      const pairs = held.slice(0, -1);
      assert.ok(
        pairs.every((entry, index) => entry === (index % 2 === 0 ? 'started' : 'ended')),
        held.join(', '),
      );
    };

    it('ends the attempt the runner could not start', async () => {
      const { held, awake } = recording();
      const broken: BrewerRunner = {
        start: () => {
          throw new Error('the runner broke');
        },
        progress: () => undefined,
      };
      assert.equal(await runServe(setup, shell({ runner: () => broken, awake })), 0);
      balanced(held);
    });

    it('ends the attempt whose end rejected', async () => {
      const { held, awake } = recording();
      const broken: BrewerRunner = {
        start: () => ({ ended: Promise.reject(new Error('the runner broke')), stop: () => {} }),
        progress: () => undefined,
      };
      assert.equal(await runServe(setup, shell({ runner: () => broken, awake })), 0);
      balanced(held);
    });

    it('lets the hold go when closing its store fails', async () => {
      const { held, awake } = recording();
      const failing = {
        ...store,
        close: () => {
          throw new Error('the store did not close');
        },
      };
      await assert.rejects(
        runServe(setup, shell({ awake, openStore: () => failing })),
        /the store did not close/,
      );
      assert.equal(held.at(-1), 'released');
    });
  });

  it('keeps the out doc an attempt ended with for the state branch (ADR 0103)', async () => {
    const text = '---\n{"status":"done","summary":"Brewed"}\n---\nNotes.\n';
    const runner = (): BrewerRunner => ({
      start: () => ({
        ended: Promise.resolve({
          ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          outDoc: text,
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    });
    assert.equal(await runServe(setup, shell({ runner })), 0);
    // The stub state branch never pushes, so the store still keeps it.
    assert.deepStrictEqual(store.keptOutDocs(), [
      { batchId: '12-1', stepId: 'brew', attempt: 1, text },
    ]);
  });

  it('says in one line when an out doc cannot be kept, and brews on (ADR 0103)', async () => {
    const runner = (): BrewerRunner => ({
      start: () => ({
        ended: Promise.resolve({
          ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          outDoc: '# Notes\n',
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    });
    const inner = store;
    store = {
      ...inner,
      withTransaction: (fn) =>
        inner.withTransaction((tx) =>
          fn({
            ...tx,
            keepOutDoc: () => {
              throw new Error('disk full');
            },
          }),
        ),
    };
    assert.equal(await runServe(setup, shell({ runner })), 0);
    assert.ok(
      lines.includes(
        'foedrum serve: the out doc of 12-1 brew#1 was not kept for the state branch: disk full',
      ),
      lines.join('\n'),
    );
    assert.equal(
      createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1')?.lane.kind,
      'on_tap',
    );
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

  it("lets the cleanup of an ended batch know each step's out doc, from its brewer (ADR 0081)", async () => {
    const managers: FakeWorktrees[] = [];
    const worktrees: ServeShell['worktrees'] = async () => {
      const manager = fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') });
      managers.push(manager);
      return manager;
    };
    assert.equal(await runServe(setup, shell({ worktrees })), 0);
    assert.deepStrictEqual(
      managers.flatMap((manager) => manager.cleans()).at(-1)?.claims.outDocs,
      new Map([['12-1/brew', 'brew.md']]),
    );
  });

  it("lets the cleanup delete the task tree's branch once the action's push recorded it (ADR 0084)", async () => {
    const managers: FakeWorktrees[] = [];
    const worktrees: ServeShell['worktrees'] = async () => {
      const manager = fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') });
      managers.push(manager);
      return manager;
    };
    assert.equal(await runServe(setup, shell({ worktrees })), 0);
    assert.equal(pushes.length, 1);
    assert.deepStrictEqual(
      managers.flatMap((manager) => manager.cleans()).at(-1)?.claims.unpushed,
      new Map(),
    );
  });

  it("gives each brewer its repository's toolchain rules", async () => {
    assert.equal(await runServe(setup, shell()), 0);
    assert.ok(plans[0]?.permissions.allow.includes('Bash(npm test*)'));
  });

  // ADR 0163: the brewer finds the repository's dependencies in its worktree.
  it("gives each fresh brewer attempt its repository's setup to run before claude", async () => {
    const npmCi = { command: 'npm ci', timeout: '10m' };
    const repositories = setup.repositories.map((repository) => ({ ...repository, setup: npmCi }));
    assert.equal(await runServe({ ...setup, repositories }, shell()), 0);
    assert.equal(plans[0]?.setup?.run.command, 'npm ci');
    assert.equal(plans[0]?.setup?.run.timeoutMs, 600_000);
  });

  // ADR 0160: the sandbox hides the logins where serve's environment moved them.
  it('gives each brewer the sandbox and where the environment moves the logins', async () => {
    const configDirs = { GH_CONFIG_DIR: '/srv/gh' };
    assert.equal(await runServe({ ...setup, sandbox: true, configDirs }, shell()), 0);
    assert.equal(plans[0]?.permissions.sandbox, true);
    assert.deepStrictEqual(plans[0]?.permissions.configDirs, configDirs);
  });

  it('keeps ticking after a tick failed for another reason than the state branch', async () => {
    const broken: BrewerRunner = {
      start: () => {
        throw new Error('the runner broke');
      },
      progress: () => undefined,
    };
    assert.equal(await runServe(setup, shell({ runner: () => broken })), 0);
    assert.ok(lines.includes('foedrum serve: a tick failed: the runner broke'), lines.join('\n'));
    // It went on ticking after the failed tick, until it was stopped.
    assert.ok(calls.filter((call) => call === 'wait 5000').length > 1, calls.join('\n'));
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
  });

  it('prints a run whose end rejected once, as a notice, and no failed tick (#130)', async () => {
    const broken: BrewerRunner = {
      start: () => ({ ended: Promise.reject(new Error('the runner broke')), stop: () => {} }),
      progress: () => undefined,
    };
    assert.equal(await runServe(setup, shell({ runner: () => broken })), 0);
    const failed = lines.filter((line) =>
      line.endsWith('failed, so it is blocked on its environment: the runner broke'),
    );
    assert.equal(failed.length, 1, lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('a tick failed')), lines.join('\n'));
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
      'foedrum serve: check steps run outside an OS sandbox on native Windows: their commands can run code a brewer wrote, with network and home-folder access (ADR 0076)';

    it('says at its start, once, that check steps run outside an OS sandbox on native Windows', async () => {
      assert.equal(await runServe({ ...setup, unsandboxedChecks: true }, shell()), 0);
      assert.equal(lines[1], outsideSandbox);
      assert.equal(lines.filter((line) => line === outsideSandbox).length, 1);
    });

    it('says nothing of it where check steps run in the sandbox (ADR 0076)', async () => {
      assert.equal(setup.unsandboxedChecks, false);
      assert.equal(await runServe(setup, shell()), 0);
      assert.ok(!lines.some((line) => line.includes('outside')), lines.join('\n'));
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
      assert.equal(await runServe({ ...stoutOnly.setup, unsandboxedChecks: true }, shell()), 0);
      assert.ok(!lines.includes(outsideSandbox), lines.join('\n'));
    });

    // A setup runs before every fresh brewer attempt too, so a recipe without a check step runs
    // it, outside a sandbox on native Windows (ADR 0163).
    it("says at its start, once, that a repository's setup runs outside an OS sandbox on native Windows, with or without a check step", async () => {
      const setupOutside =
        "foedrum serve: acme/web's setup runs outside an OS sandbox on native Windows, before brewer attempts and check steps: it can run code a brewer wrote, with network and home-folder access (ADR 0163)";
      const files = serveInputs().files;
      const withSetup = (recipes: typeof files.brewery.recipes) => {
        const ready = serveSetup(
          serveInputs({
            files: {
              ...files,
              config: config({}, { setup: { command: 'npm ci', timeout: '10m' } }),
              local: local({ workRoot: dir.path }),
              brewery: { ...files.brewery, recipes },
            },
          }),
        );
        assert.ok(ready.kind === 'ready');
        return ready.setup;
      };
      const stoutOnly = withSetup(files.brewery.recipes.slice(0, 1));
      assert.equal(await runServe({ ...stoutOnly, unsandboxedChecks: true }, shell()), 0);
      assert.equal(lines.filter((line) => line === setupOutside).length, 1, lines.join('\n'));
      assert.ok(!lines.includes(outsideSandbox), lines.join('\n'));
      lines.length = 0;
      assert.equal(await runServe(withSetup(files.brewery.recipes), shell()), 0);
      assert.ok(!lines.includes(setupOutside), 'in a sandbox it says nothing of it');
    });

    type Call = { file: string; args: readonly string[]; options: ExecOptions };
    /** Serve with a brewer that succeeds and a process runner that answers each check with `code`. */
    const brewWithChecks = async (
      code: number,
      {
        serving = setup,
        prepare,
        merge,
        steps = [],
      }: {
        serving?: ServeSetup;
        prepare?: ExecProcess;
        merge?: WorktreeMerge;
        /** What ran, in order: each check's command and its folder, after whatever else wrote here. */
        steps?: string[];
      } = {},
    ) => {
      const log = createCommandLog({ store, recipes: setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const checks: Call[] = [];
      const exec: ExecProcess = async (file, args, options) => {
        checks.push({ file, args, options });
        steps.push(`${file} in ${options.cwd}`);
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
        serving,
        shell({
          runner: () => succeeding,
          exec,
          ...(prepare === undefined ? {} : { setup: prepare }),
          ...(merge === undefined ? {} : { merge: () => merge }),
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

    it("merges the base into the check's worktree before its test command runs (ADR 0164)", async () => {
      const steps: string[] = [];
      const clean = fakeWorktreeMerge();
      const merge: WorktreeMerge = {
        ...clean,
        merge: async (path, commit, message) => {
          steps.push(`${path} ${commit}: ${message}`);
          return clean.merge(path, commit, message);
        },
      };
      const { batch } = await brewWithChecks(0, { merge, steps });
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(steps, [
        `${worktreeOf(1)} ${'b'.repeat(40)}: Merge main before green`,
        `npm test in ${worktreeOf(1)}`,
      ]);
      assert.ok(
        store
          .eventsAfter(0)
          .some(
            ({ event }) =>
              event.type === 'effect.applied' && event.key === '["13-1","green",1,"merge_base"]',
          ),
      );
    });

    it("runs the checks on an open pull request's merged tree once its base moves, and records the failing one (ADR 0203)", async () => {
      const log = createCommandLog({ store, recipes: setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const mergedRoot = join(dir.path, 'merged', 'one.tree');
      const ran: string[] = [];
      // green passes on the batch's own tree; the merged tree fails it.
      const exec: ExecProcess = async (file, _args, options) => {
        ran.push(`${file} in ${options.cwd}`);
        const code = options.cwd === mergedRoot ? 1 : 0;
        const output = code === 0 ? 'ok 1\n' : 'not ok 1 - adds\n';
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
      const trees: string[] = [];
      const checked = () => log.state().batches.get('13-1')?.baseChecks ?? [];
      const code = await runServe(
        { ...setup, intake: { ...setup.intake, pollEveryMs: 0 } },
        shell({
          runner: () => succeeding,
          exec,
          push: (repository) => ({
            commit: async () => FAKE_COMMIT,
            // green merged the base at 'b…'; once the pull request is open it moves to 'e…'.
            baseTip: async () => (pushes.length > 0 ? 'e' : 'b').repeat(40),
            isAncestor: async (commit, of) => commit === of,
            // The bottle branch holds what was pushed.
            remoteTip: async () => (pushes.length > 0 ? FAKE_COMMIT : undefined),
            push: async (commit, branch) => {
              pushes.push(`${repository.repo} ${commit} ${branch}`);
            },
            secretScan: async () => [],
            touchedFiles: async () => [],
          }),
          mergeTree: () => async () => ({ kind: 'clean' }),
          mergedTree: () => async (head, tip, use) => {
            trees.push(`${head} ${tip}`);
            return use(mergedRoot);
          },
          wait: async () => {
            calls.push('wait');
            if (checked().length > 0 || calls.length > 60) controller.abort();
          },
        }),
      );
      assert.equal(code, 0);
      assert.deepStrictEqual(trees, [`${FAKE_COMMIT} ${'e'.repeat(40)}`]);
      assert.deepStrictEqual(
        ran.filter((line) => line.endsWith(mergedRoot)),
        [`npm test in ${mergedRoot}`],
      );
      const [check] = checked();
      assert.equal(check?.tip, 'e'.repeat(40));
      assert.deepStrictEqual(check?.failed, {
        result: 'exited',
        check: 'test',
        command: 'npm test',
        ...(process.platform === 'win32' ? { unsandboxed: true } : {}),
        exitCode: 1,
        tail: 'not ok 1 - adds\n',
      });
    });

    // Serve closes the store and lets the lock go: a run underway is stopped and settles first
    // (review of #528).
    it('stops a run on the merged tree and waits for it when a tick must stop the engine', async () => {
      const log = createCommandLog({ store, recipes: setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const run = { started: false, aborted: false, settled: false };
      const exec: ExecProcess = async () => ({
        exitCode: 0,
        stdout: 'ok 1\n',
        stderr: '',
        output: 'ok 1\n',
      });
      const code = await runServe(
        { ...setup, intake: { ...setup.intake, pollEveryMs: 0 } },
        shell({
          runner: () => succeeding,
          exec,
          stateBranch: () => ({
            start: async () => ({ decision: 'ready' }),
            flush: async () => {
              if (run.started) {
                throw new StateBranchStopError('the push was rejected: another engine wrote');
              }
              return { kind: 'unchanged' };
            },
          }),
          push: (repository) => ({
            commit: async () => FAKE_COMMIT,
            baseTip: async () => (pushes.length > 0 ? 'e' : 'b').repeat(40),
            isAncestor: async (commit, of) => commit === of,
            remoteTip: async () => (pushes.length > 0 ? FAKE_COMMIT : undefined),
            push: async (commit, branch) => {
              pushes.push(`${repository.repo} ${commit} ${branch}`);
            },
            secretScan: async () => [],
            touchedFiles: async () => [],
          }),
          mergeTree: () => async () => ({ kind: 'clean' }),
          mergedTree: () => async (_head, _tip, _use, signal) => {
            run.started = true;
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            run.aborted = true;
            run.settled = true;
            throw new Error('stopped');
          },
          wait: async () => {
            calls.push('wait');
            if (calls.length > 80) controller.abort();
          },
        }),
      );
      assert.equal(code, 1);
      assert.deepStrictEqual(run, { started: true, aborted: true, settled: true });
    });

    // On the way out a pass underway may wait for its deadline: the run is stopped first, and
    // settles before the lock goes (review of #528).
    it('stops a run on the merged tree before it waits for the pass, and lets the lock go once it settled', async () => {
      const log = createCommandLog({ store, recipes: setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const events: string[] = [];
      let started = false;
      let stopped: () => void = () => {};
      const aborted = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      // The pass's read of the pull request waits until the run was stopped.
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        if (started && (init?.method ?? 'GET') === 'GET' && target.includes('/pulls/')) {
          events.push('pass waiting');
          await aborted;
          events.push('pass read');
        }
        return api.fetch(input, init);
      };
      const code = await runServe(
        { ...setup, intake: { ...setup.intake, pollEveryMs: 0 } },
        shell({
          fetch,
          // A hang guard only: the order of events is what the test reads.
          intakeDeadlineMs: 5000,
          runner: () => succeeding,
          exec: async () => ({ exitCode: 0, stdout: 'ok 1\n', stderr: '', output: 'ok 1\n' }),
          lock: () => ({
            owner: 'cellar',
            path: join(dir.path, 'drivers', 'cellar.lock'),
            held: true,
            release: () => {
              events.push('lock released');
            },
          }),
          stateBranch: () => ({
            start: async () => ({ decision: 'ready' }),
            flush: async () => {
              if (events.includes('run started')) {
                throw new StateBranchStopError('the push was rejected: another engine wrote');
              }
              return { kind: 'unchanged' };
            },
          }),
          push: (repository) => ({
            commit: async () => FAKE_COMMIT,
            baseTip: async () => (pushes.length > 0 ? 'e' : 'b').repeat(40),
            isAncestor: async (commit, of) => commit === of,
            remoteTip: async () => (pushes.length > 0 ? FAKE_COMMIT : undefined),
            push: async (commit, branch) => {
              pushes.push(`${repository.repo} ${commit} ${branch}`);
            },
            secretScan: async () => [],
            touchedFiles: async () => [],
          }),
          mergeTree: () => async () => ({ kind: 'clean' }),
          mergedTree: () => async (_head, _tip, _use, signal) => {
            started = true;
            events.push('run started');
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            events.push('run aborted');
            stopped();
            await new Promise<void>((resolve) => setImmediate(resolve));
            events.push('run settled');
            throw new Error('stopped');
          },
          wait: async () => {
            calls.push('wait');
            if (calls.length > 80) controller.abort();
          },
        }),
      );
      assert.equal(code, 1);
      const at = (event: string) => events.indexOf(event);
      assert.ok(at('run started') >= 0, events.join(', '));
      // A pass was underway, the run is stopped before it ends, and the lock goes after both.
      assert.ok(
        at('pass waiting') >= 0 && at('pass waiting') < at('run aborted'),
        events.join(', '),
      );
      assert.ok(at('run aborted') < at('pass read'), events.join(', '));
      assert.ok(
        at('run settled') >= 0 && at('run settled') < at('lock released'),
        events.join(', '),
      );
      assert.ok(!lines.some((line) => line.includes('longer than its deadline')), lines.join('\n'));
    });

    it("runs the repository's test command in the check's worktree, and the batch goes on tap", async () => {
      const { checks, events, batch } = await brewWithChecks(0);
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(
        checks.map(({ file, args, options }) => [file, args, options.cwd, options.shell]),
        [['npm test', [], worktreeOf(1), true]],
      );
      // The brewers' minimal environment and nothing else: no GitHub token under any name, no npm
      // lifecycle scripts (ADR 0063), and git with no push credential (ADR 0109).
      const env = checks[0]?.options.env ?? {};
      assert.deepStrictEqual(env, { PATH: '/usr/bin', HOME: home, ...brewerForcedEnv() });
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
            {
              result: 'exited',
              check: 'test',
              command: 'npm test',
              // serve's check runner reads this process's platform (ADR 0076).
              ...(process.platform === 'win32' ? { unsandboxed: true } : {}),
              exitCode: 0,
              tail: 'ok 1\n',
            },
          ],
        },
      ]);
    });

    it("runs the repository's setup with serve's own process runner before the check (ADR 0140)", async () => {
      const ready = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config({}, { setup: { command: 'npm ci', timeout: '10m' } }),
            local: local({ workRoot: dir.path }),
          },
        }),
      );
      assert.ok(ready.kind === 'ready');
      const installs: Call[] = [];
      const prepare: ExecProcess = async (file, args, options) => {
        installs.push({ file, args, options });
        return { exitCode: 0, stdout: '', stderr: '', output: '' };
      };
      const { checks, batch } = await brewWithChecks(0, { serving: ready.setup, prepare });
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(
        installs.map(({ file, options }) => [file, options.cwd, options.shell]),
        [['npm ci', worktreeOf(1), true]],
      );
      assert.deepStrictEqual(installs[0]?.options.env, checks[0]?.options.env);
      assert.deepStrictEqual(
        checks.map(({ file }) => file),
        ['npm test'],
      );
    });

    it("records a session for the brewer's attempt and none for the check's (ADR 0116)", async () => {
      const { events } = await brewWithChecks(0);
      const sessionOf = (stepId: string) =>
        events.flatMap((event) =>
          event.type === 'step.started' && event.stepId === stepId ? [event.session] : [],
        );
      const [brew, ...more] = sessionOf('brew');
      assert.deepStrictEqual(more, []);
      assert.match(
        brew?.id ?? '',
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(brew?.worktree, join(dir.path, 'acme.web', 'attempts', '13-1', 'brew', '1'));
      assert.deepStrictEqual(sessionOf('green'), [undefined]);
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
        { action: 'openPullRequest' },
      ],
    });
    const guarded = brewer.replace(
      '"maxAttempts": 1',
      '"maxAttempts": 1,\n  "guards": ["testsUnchanged"]',
    );
    const gauger = brewer.replace('"name": "cellarman"', '"name": "gauger"');
    const testFirstSetup = (web: Record<string, unknown>, recipeText = nip) => {
      const files = serveInputs().files;
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({}, web),
            local: local({ workRoot: dir.path }),
            brewery: {
              recipes: [{ path: 'recipes/nip.jsonc', text: recipeText }],
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
    const brewTestFirst = async (testFirst: ServeSetup, taps: string[] = []) => {
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
        const stdout = taps.shift() ?? tap;
        return { exitCode: 1, stdout, stderr: '', output: stdout };
      };
      const diffs: string[] = [];
      const folders: string[] = [];
      const code = await runServe(
        testFirst,
        shell({
          runner: () => succeeding,
          exec,
          git: async (cwd, args) => {
            folders.push(cwd);
            // The two revisions before the `--` that ends the options.
            const end = args.indexOf('--');
            const range = args.slice(end - 2, end).join(' ');
            diffs.push(range);
            const own = range.endsWith('/implement/1');
            return { code: 0, stdout: own ? '' : gaugeDiff, stderr: '' };
          },
          wait: async () => {
            calls.push('wait');
            const lane = log.state().batches.get('14-1')?.lane.kind;
            if (lane === 'on_tap' || lane === 'stuck' || calls.length > 40) controller.abort();
          },
        }),
      );
      assert.equal(code, 0);
      return { brewed, checks, diffs, folders, batch: log.state().batches.get('14-1') };
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
      const { brewed, checks, diffs, folders, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }),
      );
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual([brewed, checks], [['gauge', 'implement'], ['npm test']]);
      // All three in the local clone the worktrees were added to, never in a worktree (#210).
      assert.deepStrictEqual(folders, [clone, clone, clone]);
      // The red proof reads the Gauger's commits; the guard reads them and the cellarman's own.
      const gaugeRange = /^[0-9a-f]{40} refs\/heads\/foedrum\/14-1\/gauge\/1$/;
      assert.equal(diffs.length, 3);
      assert.match(diffs[0] ?? '', gaugeRange);
      assert.match(diffs[1] ?? '', gaugeRange);
      // The cellarman's own commits end at its attempt branch, which the task tree carries on.
      assert.match(diffs[2] ?? '', /^[0-9a-f]{40} refs\/heads\/foedrum\/14-1\/implement\/1$/);
    });

    it('lets a batch whose red proof it skips brew in a repository without a test report', async () => {
      const off = JSON.stringify({
        name: 'nip',
        description: 'Proves the tests red only when test-first.',
        steps: [
          { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
          { id: 'red', check: 'test', expect: 'fail', of: 'gauge', when: 'recipe.testFirst' },
          { id: 'implement', brewer: 'cellarman' },
          { action: 'openPullRequest' },
        ],
        testFirst: false,
      });
      const { brewed, checks, diffs, batch } = await brewTestFirst(testFirstSetup({}, off));
      assert.equal(batch?.lane.kind, 'on_tap');
      // The skipped Gauger committed no tests, so the guard has none to read either.
      assert.deepStrictEqual([brewed, checks, diffs], [['implement'], [], []]);
    });

    it('guards only the brewer with testsUnchanged, not the Gauger a failed red proof sent back', async () => {
      const routed = JSON.stringify({
        name: 'nip',
        description: 'Proves the tests red, once more after a failure, then brews.',
        steps: [
          { id: 'gauge', brewer: 'gauger' },
          {
            id: 'red',
            check: 'test',
            expect: 'fail',
            of: 'gauge',
            onFail: { goto: 'gauge', maxRounds: 1 },
          },
          { id: 'implement', brewer: 'cellarman' },
          { action: 'openPullRequest' },
        ],
      });
      const passing = 'TAP version 13\nok 1 - adds two numbers\n1..1\n';
      const { brewed, diffs, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }, routed),
        [passing],
      );
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(brewed, ['gauge', 'gauge', 'implement']);
      // Two red proofs, then the guard of the cellarman: nothing for the Gauger's second attempt.
      assert.equal(diffs.length, 4, diffs.join('\n'));
      assert.match(diffs[1] ?? '', /refs\/heads\/foedrum\/14-1\/gauge\/2$/);
    });
  });

  it('does not tick once it was stopped before it started', async () => {
    controller.abort();
    assert.equal(await runServe(setup, shell()), 0);
    assert.deepStrictEqual(types().slice(-1), ['step.scheduled']);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  // gh reads the login at the start, with the stop signal; a stop then ends that call (ADR 0073).
  it('stops with 0, and says so, when it is stopped while it reads its login', async () => {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/user') {
        controller.abort(new Error('stopped by a signal'));
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted === true) reject(init.signal.reason);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }
      return api.fetch(input, init);
    }) as typeof globalThis.fetch;
    assert.equal(await runServe(setup, shell({ fetch })), 0);
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it('still fails with the reason when its login read fails for another reason after a stop', async () => {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/user') {
        controller.abort(new Error('stopped by a signal'));
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }
      return api.fetch(input, init);
    }) as typeof globalThis.fetch;
    assert.equal(await runServe(setup, shell({ fetch })), 1);
    assert.equal(
      lines.at(-1),
      'foedrum serve: GitHub answered 401 to the login gh uses: Bad credentials',
    );
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
            // The Brewery's own #7, with the target issue's number, which no batch orders.
            { number: 7, labels: [], author: 'bob' },
            { number: 12, labels: ['recipe:stout'], author: 'ann', body: 'Add a --json flag.' },
          ],
          'acme/web': [
            {
              number: 7,
              // Never read for routing: a claimed order is routed by its Brewery issue (ADR 0156).
              labels: ['foedrum', 'recipe:other'],
              author: 'ann',
              title: 'Dark theme',
              body: 'Add a dark theme.',
            },
          ],
        },
        // Each batch's pull request merges at once, so its claim is released (ADR 0084).
        instead: (method, url) =>
          method === 'GET' && /\/pulls\/\d+$/.test(url.pathname)
            ? { status: 200, body: { state: 'closed', merged: true } }
            : undefined,
      });
      // The Brewery issue that is the order of acme/web#7, after the Brewery's own #12 (ADR 0144).
      const order = () => github.issue('acme/brewery', 13);
      const done = () => {
        // A person labels the Brewery issue once the driver opened it, between two passes; the
        // driver's lane label may already be on it (#413).
        const opened = order();
        if (opened !== undefined && !opened.labels.includes('recipe:stout')) {
          opened.labels.push('recipe:stout');
        }
        return (
          lane('12-1') === 'on_tap' &&
          lane('web-7') === 'on_tap' &&
          github.created.length === 1 &&
          github.refs.size === 0 &&
          github.comments.get('acme/web#7')?.length === 2 &&
          order()?.state === 'closed' &&
          order()?.labels.includes('foedrum:on-tap') === true
        );
      };
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
      assert.deepStrictEqual(claimed?.labels, ['foedrum', 'recipe:other']);
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
      // One Brewery issue, the title copied and the target issue linked, closed with the release.
      const opened = (github.issues['acme/brewery'] ?? []).filter((each) => each.number > 12);
      assert.deepStrictEqual(
        opened.map(({ number, title, author }) => ({ number, title, author })),
        [{ number: 13, title: 'Dark theme', author: 'ann' }],
      );
      assert.match(order()?.body ?? '', /acme\/web#7/);
      // The Brewery issue shows the claimed batch's lane and its status comment (#413); the
      // Brewery's #7 and the target issue get neither.
      assert.deepStrictEqual(
        order()?.labels.filter((label) => label.startsWith('foedrum:')),
        ['foedrum:on-tap'],
      );
      const status = github.comments.get('acme/brewery#13') ?? [];
      assert.equal(status.length, 1, JSON.stringify(status));
      assert.match(status[0]?.body ?? '', /On tap/);
      assert.deepStrictEqual(github.issue('acme/brewery', 7)?.labels, []);
      assert.equal(github.comments.get('acme/brewery#7'), undefined);
      assert.ok(
        (github.comments.get('acme/web#7') ?? []).every(({ body }) => !/status\.\d/.test(body)),
      );
      // The pull request is the target repository's: it closes the target issue and never names
      // the Brewery issue, which is private.
      const web7 = state().batches.get('web-7')?.lane;
      const url = web7?.kind === 'on_tap' ? web7.pullRequests[0] : undefined;
      const pull = github.pulls.find(
        (each) => `https://github.com/${each.repo}/pull/${each.number}` === url,
      );
      assert.match(pull?.body ?? '', /Closes acme\/web#7/);
      assert.doesNotMatch(`${pull?.title}\n${pull?.body}`, /acme\/brewery|#13\b/i);
      assert.equal(lane('13-1'), undefined, 'the intake never orders the Brewery issue');
    });

    it('opens the Brewery issue of a target issue ordered by hand (ADR 0105, ADR 0144)', async () => {
      store = empty();
      setup = intakeSetup();
      const log = createCommandLog({ store, recipes: setup.recipes });
      const order = { issue: 7, repo: 'acme/web' };
      const by = { by: 'ann', via: 'terminal' } as const;
      log.issue({ kind: 'order_again', batchId: 'web-7', order, ...by }, t0);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [],
          'acme/web': [{ number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme' }],
        },
      });
      const marked = () =>
        github.comments.get('acme/web#7')?.length === 1 &&
        github.issues['acme/brewery']?.length === 1;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(marked) })), 0);
      assert.ok(marked(), lines.join('\n'));
      assert.deepStrictEqual(
        (github.issues['acme/brewery'] ?? []).map(({ number, title }) => ({ number, title })),
        [{ number: 1, title: 'Dark theme' }],
      );
    });

    it("polls every pollEvery, not at every tick, and reads the token's login without a target intake", async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      const stop = () => now >= t0.getTime() + 125_000;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0, 60 and 120 seconds.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
      // The status comments count only the Brewery's own comments (ADR 0072).
      assert.equal(github.requests.includes('GET /user'), true);
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

    it("holds a new order past foedrum.jsonc's openOrders, and says so once (ADR 0217)", async () => {
      store = empty();
      setup = intakeSetup({ concurrency: 2, openOrders: 1 });
      // A recipe the Brewery lacks: the batch stays Ordered, its order open.
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [12, 13].map((number) => ({
            number,
            labels: ['recipe:pint'],
            author: 'ann',
          })),
        },
      });
      const stop = () => calls.filter((call) => call === 'wait').length >= 3;
      await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop, 0) }));
      assert.deepStrictEqual([...state().batches.keys()], ['12-1']);
      const waits = lines.filter((line) => line.includes('#13 waits'));
      assert.deepStrictEqual(waits, [
        "foedrum serve: Acme/Brewery#13 waits: 1 order is open, the Brewery's openOrders",
      ]);
    });

    it('holds a second order of a recipe at its own concurrency, read from the recipe file (ADR 0217)', async () => {
      store = empty();
      const files = serveInputs().files;
      const limited = JSON.stringify({ ...JSON.parse(recipe), concurrency: 1 });
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({ concurrency: 2 }, {}),
            local: local({ workRoot: dir.path }),
            brewery: {
              ...files.brewery,
              recipes: files.brewery.recipes.map((each) =>
                each.path === 'recipes/stout.jsonc' ? { ...each, text: limited } : each,
              ),
            },
          },
        }),
      );
      setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [12, 13].map((number) => ({
            number,
            labels: ['recipe:stout'],
            author: 'ann',
          })),
        },
      });
      const stop = () => calls.filter((call) => call === 'wait').length >= 3;
      await runServe(setup, shell({ fetch: github.fetch, ...ticking(stop, 0) }));
      assert.deepStrictEqual([...state().batches.keys()], ['12-1']);
      const waits = lines.filter((line) => line.includes('#13 waits'));
      assert.deepStrictEqual(waits, [
        'foedrum serve: Acme/Brewery#13 waits: recipe stout brews its 1 at once (concurrency)',
      ]);
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

    it("records the release a merged release blocker waits on, through GitHub's API (ADR 0223)", async () => {
      store = empty();
      const lib = 'acme/lib-core';
      const merged = 'https://github.com/acme/lib-core/pull/5';
      const routeBy = '2026-10-17T13:00:00.000Z';
      store.withTransaction((tx) => {
        for (const event of [
          { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy },
          {
            type: 'order.decomposed',
            batchId: '1-1',
            subOrders: [
              { issue: 2, repo: lib },
              { issue: 3, repo: 'acme/web' },
            ],
            dependencies: [{ subOrder: 3, blockedBy: 2, kind: 'release' }],
          },
          { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
          {
            type: 'batch.ordered',
            batchId: '2-1',
            order: { issue: 2 },
            parentBatchId: '1-1',
            routeBy,
          },
          { type: 'batch.on_tap', batchId: '2-1', pullRequests: [merged] },
          { type: 'pull_request.ended', batchId: '2-1', pullRequest: merged, state: 'merged' },
        ] satisfies Event[]) {
          tx.append(event);
        }
      });
      setup = intakeSetup({ concurrency: 2 });
      const sha = 'c'.repeat(40);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => {
          switch (url.pathname) {
            case '/repos/acme/lib-core/releases/latest':
              return {
                status: 200,
                body: { tag_name: 'v1.0.0', published_at: '2026-10-17T11:00:00Z' },
              };
            case '/repos/acme/lib-core/pulls/5':
              return {
                status: 200,
                body: {
                  state: 'closed',
                  merged: true,
                  merged_at: '2026-10-17T10:00:00Z',
                  merge_commit_sha: sha,
                },
              };
            case `/repos/acme/lib-core/compare/v1.0.0...${sha}`:
              return { status: 200, body: { status: 'behind' } };
            default:
              return undefined;
          }
        },
      });
      const recorded = () => state().releases.length > 0;
      assert.equal(await runServe(setup, shell({ fetch: github.fetch, ...ticking(recorded) })), 0);
      assert.deepStrictEqual(
        state().releases.map(({ repo, version }) => `${repo} ${version}`),
        [`${lib} v1.0.0`],
      );
      assert.ok(lines.includes(`foedrum serve: recorded the release v1.0.0 of ${lib}`));
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
        'foedrum serve: GitHub answered 401 to the login gh uses: Bad credentials',
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
          kind: 'run_failed',
          ref: { batchId: '12-1', stepId: 'brew', attempt: 1 },
          error: new Error('the stream reader broke'),
        }),
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
        'the run of step brew#1 of batch 12-1 failed, so it is blocked on its environment: the stream reader broke',
        'cleaned batch 12-1: removed worktree 12-1/brew/1; could not clean x: busy',
        'cleaned batch 12-1: nothing to remove',
      ],
    );
  });

  it('says which attempt a waiting attempt waits for and when its lease expires (#155)', () => {
    assert.equal(
      formatNotice({
        kind: 'waiting_for_lease',
        ref: { batchId: '12-1', stepId: 'brew', attempt: 2 },
        waitsFor: { batchId: '12-1', stepId: 'brew', attempt: 1 },
        expiresAt: t0,
      }),
      'step brew#2 of batch 12-1 waits until the lease of brew#1 is released; it expires at 2026-10-17T12:00:00.000Z unless it is renewed',
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
        formatIntakeNotice({
          kind: 'held',
          repo: 'acme/web',
          issue: 5,
          reason: 'recipe pint is full',
        }),
        formatIntakeNotice({ kind: 'released', repo: 'acme/lib-core', version: 'v2.4.0' }),
        formatIntakeNotice({ kind: 'taken', repo: 'acme/web', issue: 3, by: 'bob/brewery' }),
        formatIntakeNotice({ kind: 'taken', repo: 'acme/web', issue: 4, by: undefined }),
        formatIntakeNotice({ kind: 'refused', command, reason: 'batch 12-1 exists' }),
        formatIntakeNotice({ kind: 'failed', what: 'listing acme/web', error: new Error('502') }),
      ],
      [
        'ordered acme/web#7 as batch web-7',
        'routed batch web-7 to the recipe stout',
        'batch 12-1 is not routed: no recipe pint',
        'acme/web#5 waits: recipe pint is full',
        'recorded the release v2.4.0 of acme/lib-core',
        'acme/web#3 is claimed by bob/brewery',
        'acme/web#4 is claimed by a ref whose record cannot be read',
        'order of batch 12-1 was refused: batch 12-1 exists',
        'the intake failed listing acme/web: 502',
      ],
    );
  });
});
