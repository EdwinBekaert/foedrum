// The setup `foedrum serve`'s tests share (ADR 0063): an in-memory store with an order routed to
// the one-step recipe, a fake GitHub, and serve's shell over fake worktrees, with a runner that asks
// for the plan and ends each attempt itself. `serveFixture` registers the hooks in the describe that
// calls it, and its fields hold the current test's state, so a test reads them through the object.
// No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { ghOver } from './fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from './fake-github-api.ts';
import { fakeLock } from './fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from './fake-worktrees.ts';
import { local, serveInputs } from './serve-brewery.ts';
import { makeTempDir, type TempDir } from './temp-dir.ts';

export const t0 = new Date('2026-10-17T12:00:00.000Z');

export interface ServeFixture {
  dir: TempDir;
  setup: ServeSetup;
  store: EventStore;
  closed: number;
  calls: string[];
  lines: string[];
  controller: AbortController;
  lock: ReturnType<typeof fakeLock>;
  plans: ClaudeAttemptPlan[];
  /** The Brewery's issue 12 with its text, where the status comment goes too (ADR 0072). */
  api: FakeGitHubApi;
  // What the shell's pushes pushed, as `<repo> <commit> <branch>`.
  pushes: string[];
  // The waits that saw the batch on tap.
  onTapWaits: number;
  shell: (overrides?: Partial<ServeShell> & { fetch?: typeof globalThis.fetch }) => ServeShell;
  /** The types of the events so far, without effect.applied. */
  types: () => string[];
}

export const serveFixture = (): ServeFixture => {
  const f = {} as ServeFixture;

  beforeEach(() => {
    f.pushes = [];
    f.onTapWaits = 0;
    f.dir = makeTempDir('serve');
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }) } }),
    );
    assert.equal(result.kind, 'ready');
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    f.store = openSqliteEventStore(':memory:');
    const inner = f.store;
    f.closed = 0;
    f.store = {
      ...inner,
      close: () => {
        f.closed++;
      },
    };
    f.calls = [];
    f.lines = [];
    f.controller = new AbortController();
    f.lock = fakeLock('cellar');
    f.plans = [];
    f.api = fakeGitHubApi({
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
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label', source: 'label' },
      t0,
    );
  });
  afterEach(() => f.dir.remove());

  /** A runner whose attempts ask for their plan, then succeed, or fail when it cannot be made. */
  const planningRunner = (plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>) => {
    const runner: BrewerRunner = {
      start: (start) => ({
        ended: plan(start).then(
          (made) => {
            f.plans.push(made);
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
    fetch = f.api.fetch,
    ...overrides
  }: Partial<ServeShell> & { fetch?: typeof globalThis.fetch } = {}): ServeShell => ({
    out: (line) => f.lines.push(line),
    signal: f.controller.signal,
    clock: () => t0,
    // Stops serve one tick after the batch went on tap, or after 20 ticks: the openPullRequest
    // action ends it after the drive, and the next tick's drive cleans it (ADR 0037).
    wait: async (ms) => {
      f.calls.push(`wait ${ms}`);
      const lane = createCommandLog({ store: f.store, recipes: f.setup.recipes })
        .state()
        .batches.get('12-1')?.lane.kind;
      if (lane === 'on_tap') f.onTapWaits++;
      if (f.onTapWaits > 1 || f.calls.length > 40) f.controller.abort();
    },
    lock: (workRoot, options) => {
      f.calls.push(`lock ${options.owner} ${options.brewery} ${workRoot === f.dir.path}`);
      return f.lock;
    },
    openStore: (path) => {
      f.calls.push(`store ${path === f.setup.store}`);
      return f.store;
    },
    stateBranch: () => ({
      start: async () => {
        f.calls.push('state branch');
        return { decision: 'ready' };
      },
      flush: async () => ({ kind: 'unchanged' }),
    }),
    worktrees: async (repository) => {
      f.calls.push(`worktrees ${repository.repo} ${repository.base}`);
      return fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') });
    },
    merge: () => fakeWorktreeMerge(),
    push: (repository) => ({
      // The task tree is at FAKE_COMMIT, the base elsewhere.
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit, of) => commit === of,
      remoteTip: async () => undefined,
      push: async (commit, branch) => {
        f.pushes.push(`${repository.repo} ${commit} ${branch}`);
      },
      secretScan: async () => [],
      touchedFiles: async () => [],
    }),
    runner: (claude, plan) => {
      f.calls.push(`runner ${claude}`);
      return planningRunner(plan);
    },
    // The stout recipe has no check step.
    exec: () => Promise.reject(new Error('no check step runs here')),
    setup: () => Promise.reject(new Error('no repository setup runs here')),
    gh: ghOver(fetch).exec,
    // A check step looks for the test map (ADR 0274): the clone has none.
    git: (_cwd, args) =>
      args[0] === 'ls-tree'
        ? Promise.resolve({ code: 0, stdout: '', stderr: '' })
        : Promise.reject(new Error('no red proof or guarded step runs here')),
    ...overrides,
  });

  const types = () =>
    f.store
      .eventsAfter(0)
      .map(({ event }) => event.type)
      .filter((type) => type !== 'effect.applied');

  f.shell = shell;
  f.types = types;
  return f;
};
