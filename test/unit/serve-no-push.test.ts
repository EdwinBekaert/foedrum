// `foedrum serve` with brewers that name noPush (ADR 0106): it reads each repository's refs through
// its shell around their attempts, notes its own writes, and leaves out the state branch. Its own
// file, apart from serve.test.ts, so each stays within the per-file CPU budget (ADR 0036). An
// in-memory store, fake worktrees, a fake GitHub and runners that end each attempt themselves; no
// process starts (ADR 0021).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runServe, type ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-10-17T12:00:00.000Z');

describe('runServe: the noPush guard (ADR 0106)', () => {
  let dir: TempDir;
  let setup: ServeSetup;
  let store: EventStore;
  let calls: string[];
  let controller: AbortController;
  /** The Brewery's issues 12 and 13 with their text, where the status comments go too. */
  let api: FakeGitHubApi;

  beforeEach(() => {
    dir = makeTempDir('serve-no-push');
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot: dir.path }) } }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail();
    const inner = openSqliteEventStore(':memory:');
    // Serve closes its store at the end; the test reads it after.
    store = { ...inner, close: () => {} };
    calls = [];
    controller = new AbortController();
    api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [12, 13].map((number) => ({
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

  /** A runner whose attempts ask for their plan, then succeed. */
  const planningRunner: ServeShell['runner'] = (_claude, plan) => ({
    start: (start) => ({
      ended: plan(start).then((made) => {
        // As the claude runner does, before claude starts.
        writeFileSync(made.settingsFile, '{}');
        const output = { status: 'done', summary: 'Brewed', assumptions: [] };
        return { ending: { kind: 'succeeded', output } } as const;
      }),
      stop: () => {},
    }),
    progress: () => undefined,
  });

  // GitHub through a fake gh over a fake fetch (ADR 0073).
  const shell = (overrides: Partial<ServeShell> = {}): ServeShell => ({
    out: () => {},
    signal: controller.signal,
    clock: () => t0,
    wait: async () => {
      calls.push('wait');
      if (calls.length > 40) controller.abort();
    },
    lock: () => fakeLock('cellar'),
    openStore: () => store,
    stateBranch: () => ({
      start: async () => ({ decision: 'ready' }),
      flush: async () => ({ kind: 'unchanged' }),
    }),
    worktrees: async () => fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') }),
    push: () => ({
      // The task tree is at FAKE_COMMIT, the base elsewhere.
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit, of) => commit === of,
      remoteTip: async () => undefined,
      push: async () => {},
      secretScan: async () => [],
    }),
    refs: () => async () => '',
    runner: planningRunner,
    exec: () => Promise.reject(new Error('no check step runs here')),
    gh: ghOver(api.fetch).exec,
    git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
    ...overrides,
  });

  const pushless = brewer.replace('"maxAttempts": 1', '"maxAttempts": 1,\n  "guards": ["noPush"]');
  const before = `${'a'.repeat(40)}\trefs/heads/main\n`;
  const after = `${'b'.repeat(40)}\trefs/heads/main\n`;

  it("reads the target repository's remote before and after an attempt, and makes the batch Stuck when a ref moved (done when, #173)", async () => {
    const files = serveInputs().files;
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: dir.path }),
          brewery: {
            ...files.brewery,
            brewers: [{ path: 'brewers/cellarman.md', text: pushless }],
          },
        },
      }),
    );
    const guarded = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    const log = createCommandLog({ store, recipes: guarded.recipes });
    const listings = [before, after];
    const reads: string[] = [];
    const code = await runServe(
      guarded,
      shell({
        refs: (repository) => async () => {
          reads.push(repository.repo);
          return listings.shift() ?? after;
        },
        wait: async () => {
          calls.push('wait');
          const lane = log.state().batches.get('12-1')?.lane.kind;
          if (lane === 'on_tap' || lane === 'stuck' || calls.length > 40) controller.abort();
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepStrictEqual(reads, ['acme/web', 'acme/web']);
    const batch = log.state().batches.get('12-1');
    assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
      kind: 'blocked',
      stepId: 'brew',
      blockerKind: 'divergence',
      summary: `the guard noPush: the remote of acme/web changed during the attempt: refs/heads/main moved from ${'a'.repeat(40)} to ${'b'.repeat(40)}`,
    });
  });

  const porter = JSON.stringify({
    name: 'porter',
    description: 'Brews an order in one step and opens its pull request.',
    steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
    testFirst: false,
  });
  /** A setup whose cellarman names noPush, with stout and porter. */
  const guardedSetup = (
    fields: Record<string, unknown> = {},
    web: Record<string, unknown> = {},
  ) => {
    const files = serveInputs().files;
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          config: config(fields, web),
          local: local({ workRoot: dir.path }),
          brewery: {
            recipes: [
              { path: 'recipes/stout.jsonc', text: recipe },
              { path: 'recipes/porter.jsonc', text: porter },
            ],
            brewers: [{ path: 'brewers/cellarman.md', text: pushless }],
          },
        },
      }),
    );
    return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
  };
  /** Serve until each batch is on tap or Stuck; the lanes it ended in. */
  const brewUntilSettled = async (
    guarded: ServeSetup,
    batches: string[],
    overrides: Partial<ServeShell>,
  ) => {
    const log = createCommandLog({ store, recipes: guarded.recipes });
    const lanes = () => batches.map((id) => log.state().batches.get(id)?.lane.kind);
    const code = await runServe(
      guarded,
      shell({
        ...overrides,
        wait: async () => {
          calls.push('wait');
          const settled = lanes().every((lane) => lane === 'on_tap' || lane === 'stuck');
          if (settled || calls.length > 40) controller.abort();
        },
      }),
    );
    assert.equal(code, 0);
    return { lanes: lanes(), log };
  };
  const withState = (sha: string) =>
    `${'a'.repeat(40)}\trefs/heads/main\n${sha}\trefs/heads/foedrum/state\n`;

  it("leaves out the Brewery's own state branch, whose push guards itself (ADR 0024)", async () => {
    const guarded = guardedSetup();
    // The Brewery is its own target repository.
    const own = {
      ...guarded,
      repositories: guarded.repositories.map((each) => ({ ...each, repo: 'acme/brewery' })),
    };
    const listings = [withState('a'.repeat(40)), withState('b'.repeat(40))];
    const reads: string[] = [];
    const { lanes } = await brewUntilSettled(own, ['12-1'], {
      refs: (repository) => async () => {
        reads.push(repository.repo);
        return listings.shift() ?? withState('b'.repeat(40));
      },
    });
    assert.deepStrictEqual(reads, ['acme/brewery', 'acme/brewery']);
    assert.deepStrictEqual(lanes, ['on_tap']);
  });

  it("counts a branch named like the state branch in another repository than the Brewery's", async () => {
    const listings = [withState('a'.repeat(40)), withState('b'.repeat(40))];
    const { lanes } = await brewUntilSettled(guardedSetup(), ['12-1'], {
      refs: () => async () => listings.shift() ?? withState('b'.repeat(40)),
    });
    assert.deepStrictEqual(lanes, ['stuck']);
  });

  it("leaves out another batch's bottle push made during the attempt, which serve notes", async () => {
    const guarded = guardedSetup({ concurrency: 2 });
    const log = createCommandLog({ store, recipes: guarded.recipes });
    log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
    const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
    log.issue({ ...route, source: 'label' }, t0);
    // Batch 12-1's brewer runs until batch 13-1's bottle is pushed.
    const pushed: string[] = [];
    let bottled: () => void = () => {};
    const bottle = new Promise<void>((resolve) => {
      bottled = resolve;
    });
    const output = { status: 'done', summary: 'Brewed' };
    const runner: BrewerRunner = {
      start: ({ ref }) => ({
        ended: (ref.batchId === '12-1' ? bottle : Promise.resolve()).then(() => ({
          ending: { kind: 'succeeded', output },
        })),
        stop: () => {},
      }),
      progress: () => undefined,
    };
    const { lanes } = await brewUntilSettled(guarded, ['12-1', '13-1'], {
      runner: () => runner,
      push: () => ({
        commit: async () => FAKE_COMMIT,
        baseTip: async () => 'b'.repeat(40),
        isAncestor: async (commit, of) => commit === of,
        remoteTip: async () => undefined,
        push: async (_commit, branch) => {
          pushed.push(branch);
          bottled();
        },
        secretScan: async () => [],
      }),
      refs: () => async () =>
        [
          `${'a'.repeat(40)}\trefs/heads/main`,
          ...pushed.map((b) => `${FAKE_COMMIT}\trefs/heads/${b}`),
        ]
          .map((line) => `${line}\n`)
          .join(''),
    });
    // 13-1's bottle came while 12-1's brewer ran; 12-1's own came after its attempt.
    assert.deepStrictEqual(
      pushed.map((branch) => branch.split('/')[2]),
      ['13-1', '12-1'],
    );
    assert.deepStrictEqual(lanes, ['on_tap', 'on_tap']);
  });

  it('leaves out a claim ref the intake creates during the attempt, which serve notes', async () => {
    const guarded = guardedSetup(
      { concurrency: 2 },
      { alias: 'web', intake: { labels: ['foedrum'] } },
    );
    // The claim waits until batch 12-1's brewer runs, and 12-1's brewer until the claim is made.
    let brewing = false;
    let claimed: () => void = () => {};
    const claim = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [{ number: 12, labels: [], author: 'ann', body: 'Add a --json flag.' }],
        'acme/web': [
          { number: 7, labels: ['foedrum', 'recipe:stout'], author: 'ann', body: 'Add a theme.' },
        ],
      },
      instead: (method, url) => {
        if (method !== 'POST' || !url.pathname.endsWith('/git/refs')) return undefined;
        if (!brewing) return { status: 500, body: { message: 'not yet' } };
        setTimeout(claimed, 1);
        return undefined;
      },
    });
    const output = { status: 'done', summary: 'Brewed' };
    const runner: BrewerRunner = {
      start: ({ ref }) => {
        if (ref.batchId === '12-1') brewing = true;
        return {
          ended: (ref.batchId === '12-1' ? claim : Promise.resolve()).then(() => ({
            ending: { kind: 'succeeded', output },
          })),
          stop: () => {},
        };
      },
      progress: () => undefined,
    };
    let now = t0.getTime();
    const listing = () =>
      [
        `${'a'.repeat(40)}\trefs/heads/main`,
        ...[...github.refs]
          .filter(([key]) => key.startsWith('acme/web '))
          .map(([key, sha]) => `${sha}\t${key.slice('acme/web '.length)}`),
      ]
        .map((line) => `${line}\n`)
        .join('');
    const log = createCommandLog({ store, recipes: guarded.recipes });
    const code = await runServe(
      guarded,
      shell({
        gh: ghOver(github.fetch).exec,
        runner: () => runner,
        refs: () => async () => listing(),
        clock: () => new Date(now),
        wait: async () => {
          calls.push('wait');
          now += 5000;
          await new Promise((resolve) => setTimeout(resolve, 1));
          const lane = log.state().batches.get('12-1')?.lane.kind;
          if (lane === 'on_tap' || lane === 'stuck' || calls.length > 200) controller.abort();
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepStrictEqual(github.created, ['acme/web refs/foedrum/claims/issues/7']);
    assert.equal(log.state().batches.get('12-1')?.lane.kind, 'on_tap');
  });
});
