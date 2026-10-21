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
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, local, serveInputs } from '../helpers/serve-brewery.ts';
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
});
