// The merge of the base before a batch's last check, with real git (ADR 0164): a bare origin and
// the user's clone, a batch brewed through openDriver whose implement step commits while someone
// else merges into main, its green check run in a worktree that has the base merged in, and the
// pull request pushed from what green checked. The pull request goes to a fake code host.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { baseMergeKey, baseMergeTarget } from '../../src/engine/base-merge.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { State } from '../../src/engine/fold.ts';
import { type PullRequestHost, pullRequestActions } from '../../src/engine/pull-request-actions.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { MergeResult } from '../../src/schemas/store.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import { openWorktreeMerge } from '../../src/workspace/base-merge-git.ts';
import { openBranchPush } from '../../src/workspace/branch-push-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const recipes = fakeRecipes({
  nip: fakeRecipe({
    steps: ['implement', 'green', 'open-pull-request'],
    actions: { 'open-pull-request': 'openPullRequest' },
    merges: ['green'],
    // A failure on the pull request goes back to implement (ADR 0219, ADR 0226).
    routes: { 'open-pull-request': { pull_request: 'implement' } },
    pullRequests: [],
  }),
});
const bottle = 'foedrum/acme.brewery/12-1/acme.app';
const url = 'https://github.com/acme/app/pull/1';
const green: AttemptRef = { batchId: '12-1', stepId: 'green', attempt: 1 };

/** What the green check saw in its worktree when it ran. */
interface Seen {
  head: string;
  files: string[];
}

describe('the merge of the base before green, with real git (ADR 0164)', () => {
  let dir: TempDir;
  let origin: string;
  let user: string;
  let other: string;
  let store: EventStore;

  // Every git of the file, the engine's included, reads only the test's own configuration: the
  // machine's (a global commit.gpgsign, an editor) takes no part. The file runs in a process of
  // its own.
  const machine = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_NOSYSTEM,
  };
  before(() => {
    dir = makeTempDir('base-merge');
    const config = join(dir.path, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Test\n\temail = t@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  after(() => {
    for (const [name, value] of [
      ['GIT_CONFIG_GLOBAL', machine.global],
      ['GIT_CONFIG_NOSYSTEM', machine.system],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeTree(dir.path);
  });
  let runs = 0;
  beforeEach(() => {
    const run = join(dir.path, String(++runs));
    const seed = join(run, 'seed');
    origin = join(run, 'origin.git');
    user = join(run, 'user');
    other = join(run, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'readme.txt'), 'hello\n');
    git(seed, ['add', 'readme.txt']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
    git(run, ['clone', '-q', '--bare', seed, origin]);
    git(run, ['clone', '-q', origin, user]);
    git(run, ['clone', '-q', origin, other]);
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  /** Someone else merges `file` with `text` into main while the batch brews; its commit. */
  const mergeIntoMain = (file: string, text: string): string => {
    writeFileSync(join(other, file), text);
    git(other, ['add', file]);
    git(other, ['commit', '-q', '-m', `Change ${file}`]);
    git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    return git(other, ['rev-parse', 'HEAD']).trim();
  };

  /** Commits `file` with `text` in the worktree at `path`. */
  const commit = (path: string, file: string, text: string): void => {
    writeFileSync(join(path, file), text);
    git(path, ['add', file]);
    git(path, ['commit', '-q', '-m', `Implement ${file}`]);
  };

  const own = () => ({ url: origin, root: join(dir.path, `git-dirs-${runs}`) });

  /**
   * Brews batch 12-1 of Nip, whose implement step does `work`, to the end of one tick, then runs
   * `then` with the driver before it closes.
   */
  const brew = async (
    work: (path: string, attempt: number) => void,
    then?: (driver: Awaited<ReturnType<typeof openDriver>>) => Promise<void>,
  ) => {
    const clock = () => new Date('2026-10-23T12:00:00.000Z');
    // The pull request's body, which a later round renders again (ADR 0227).
    let body: string | undefined;
    const host: PullRequestHost = {
      find: async () => undefined,
      open: async (_repo, request) => {
        body = request.body;
        return url;
      },
      body: async () => body ?? assert.fail('no pull request was opened'),
      update: async (_url, text) => {
        body = text;
      },
    };
    let driver: Awaited<ReturnType<typeof openDriver>> | undefined;
    const worktreeOf = (ref: AttemptRef): string => {
      const started = driver
        ?.state()
        .batches.get(ref.batchId)
        ?.steps.get(ref.stepId)
        ?.attempts.get(ref.attempt);
      assert.ok(started?.phase === 'started' && started.worktree !== undefined);
      return started.worktree.path;
    };
    const seen: Seen[] = [];
    const runner = fakeBrewerRunner(({ ref }) => {
      const path = worktreeOf(ref);
      if (ref.stepId === 'implement') work(path, ref.attempt);
      else {
        seen.push({
          head: git(path, ['rev-parse', 'HEAD']).trim(),
          files: readdirSync(path)
            .filter((name) => name !== '.git')
            .sort(),
        });
      }
      return behave.succeed();
    });
    const push = openBranchPush({ git: runGit, clone: user, own: own() });
    driver = await openDriver({
      store,
      runner,
      recipes,
      clock,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      brews: () => false,
      worktrees: [
        {
          repo: 'acme/app',
          base: 'origin/main',
          manager: openAttemptWorktrees({
            git: runGit,
            workRoot: join(dir.path, `work-${runs}`),
            repo: 'acme/app',
            clone: user,
            own: own(),
          }),
          merge: { base: 'main', push, worktree: openWorktreeMerge({ git: runGit, clone: user }) },
        },
      ],
      actions: pullRequestActions({
        brewery: 'acme/brewery',
        repositories: [{ repo: 'acme/app', base: 'main', push }],
        host,
        orderTitle: async () => 'Add a plan',
      }),
    });
    try {
      const intake = createCommandLog({ store, recipes });
      intake.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, clock());
      const route = { kind: 'route', batchId: '12-1', recipe: 'nip', reason: 'label' } as const;
      intake.issue({ ...route, source: 'label' }, clock());
      await driver.tick();
      await then?.(driver);
      return { state: driver.state(), seen };
    } finally {
      driver.close();
    }
  };

  /** The worktree an attempt finished in, and the commit its step started at. */
  const finished = (state: State, ref: AttemptRef) => {
    const attempt = state.batches
      .get(ref.batchId)
      ?.steps.get(ref.stepId)
      ?.attempts.get(ref.attempt);
    assert.ok(attempt?.phase === 'finished' && attempt.worktree !== undefined);
    return { attempt, worktree: attempt.worktree };
  };
  const implementTip = (state: State): string =>
    git(user, [
      'rev-parse',
      `refs/heads/${finished(state, { ...green, stepId: 'implement' }).worktree.branch}`,
    ]).trim();
  const merged = (state: State) => state.effects.get(effectKey.encode(baseMergeKey(green)));

  it('merges a base that moved cleanly as a commit of its own, and green checks the merged tree', async () => {
    let base = '';
    const { state, seen } = await brew((path) => {
      commit(path, 'plan.txt', 'plan\n');
      base = mergeIntoMain('other.txt', 'other\n');
    });
    const tip = implementTip(state);
    assert.equal(seen.length, 1);
    const [check] = seen;
    assert.ok(check !== undefined);
    assert.deepEqual(check.files, ['other.txt', 'plan.txt', 'readme.txt']);
    // A merge commit of the implement step's tip and the base as it is now.
    assert.deepEqual(
      git(user, ['rev-parse', `${check.head}^1`, `${check.head}^2`])
        .trim()
        .split(/\r?\n/),
      [tip, base],
    );
    assert.deepEqual(merged(state), { base, merged: check.head });
    // The pull request opens on what green checked.
    assert.equal(git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim(), check.head);
    assert.deepEqual(state.batches.get('12-1')?.lane, { kind: 'on_tap', pullRequests: [url] });
  });

  it('aborts a merge that conflicts, and the batch goes Stuck with the files it conflicts in', async () => {
    const { state, seen } = await brew((path) => {
      commit(path, 'readme.txt', 'mine\n');
      commit(path, 'plan.txt', 'plan\n');
      mergeIntoMain('readme.txt', 'theirs\n');
    });
    const tip = implementTip(state);
    assert.deepEqual(seen, []);
    const lane = state.batches.get('12-1')?.lane;
    assert.ok(lane?.kind === 'stuck');
    assert.deepEqual(lane.reason, {
      kind: 'blocked',
      stepId: 'green',
      blockerKind: 'divergence',
      summary: 'conflicts with main in readme.txt',
    });
    // The worktree is back where green started: no merge in progress, nothing changed.
    const { worktree } = finished(state, green);
    assert.equal(git(worktree.path, ['rev-parse', 'HEAD']).trim(), tip);
    assert.equal(git(worktree.path, ['status', '--porcelain']), '');
    assert.throws(() => git(worktree.path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']));
    assert.equal(git(origin, ['for-each-ref', '--format=%(refname)', `refs/heads/${bottle}`]), '');
  });

  it('pushes past what looks like a secret that the merge brought in from the base (review of #438)', async () => {
    // Built at run time, so no scanner takes this file for one that holds a token.
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    const { state, seen } = await brew((path) => {
      commit(path, 'plan.txt', 'plan\n');
      // Main merged a fixture that looks like a secret: the base's, not the batch's.
      mergeIntoMain('fixture.txt', `${token}\n`);
    });
    assert.deepEqual(state.batches.get('12-1')?.lane, { kind: 'on_tap', pullRequests: [url] });
    const [check] = seen;
    assert.ok(check !== undefined);
    assert.equal(git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim(), check.head);
  });

  it('merges nothing when the base did not move', async () => {
    const { state, seen } = await brew((path) => commit(path, 'plan.txt', 'plan\n'));
    const tip = implementTip(state);
    const base = git(origin, ['rev-parse', 'refs/heads/main']).trim();
    assert.deepEqual(
      seen.map(({ head }) => head),
      [tip],
    );
    assert.deepEqual(merged(state), { base });
    assert.equal(git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim(), tip);
  });

  it('merges the base at the start of a fix the merged tree sent back, and green finds nothing new (ADR 0226)', async () => {
    const fix: AttemptRef = { batchId: '12-1', stepId: 'implement', attempt: 2 };
    let seenByFix: string[] = [];
    let base = '';
    const { state } = await brew(
      (path, attempt) => {
        if (attempt === 1) return commit(path, 'plan.txt', 'plan\n');
        // The fix sees what main brought in, and fixes on top of it.
        seenByFix = readdirSync(path)
          .filter((name) => name !== '.git')
          .sort();
        commit(path, 'fix.txt', 'fix\n');
      },
      async (driver) => {
        // Main moves on, and the merged-check run found the pushed head failing with it.
        base = mergeIntoMain('other.txt', 'other\n');
        const head = git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim();
        const reading = {
          result: 'exited',
          check: 'test',
          command: 'npm test',
          exitCode: 1,
          tail: 'not ok 1',
        } as const;
        const event = {
          type: 'pull_request.base_checked',
          batchId: '12-1',
          pullRequest: url,
          branch: 'main',
          tip: base,
          head,
          failed: reading,
        } as const;
        const intake = createCommandLog({ store, recipes });
        assert.equal(
          intake.issue({ kind: 'record', event }, new Date('2026-10-23T12:00:00.000Z')).kind,
          'accepted',
        );
        await driver.tick();
      },
    );
    assert.deepEqual(seenByFix, ['other.txt', 'plan.txt', 'readme.txt']);
    const start = MergeResult.parse(state.effects.get(effectKey.encode(baseMergeKey(fix))));
    assert.equal(start.base, base);
    assert.ok(start.merged !== undefined, 'the fix merged the base as a commit of its own');
    // Green merges again and finds the base already in.
    const again = state.effects.get(effectKey.encode(baseMergeKey({ ...green, attempt: 2 })));
    assert.deepEqual(again, { base });
    // The fix, on top of the base it merged, is pushed to the same branch.
    const pushed = git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim();
    assert.equal(git(origin, ['merge-base', '--is-ancestor', base, pushed]), '');
    assert.deepEqual(state.batches.get('12-1')?.lane, { kind: 'on_tap', pullRequests: [url] });
  });

  describe('found by its key after a kill (ADR 0033)', () => {
    /** A worktree of the user's clone at a commit of plan.txt, and that commit. */
    const worktree = (file = 'plan.txt', text = 'plan\n') => {
      const path = join(dir.path, `tree-${runs}`);
      git(user, ['worktree', 'add', '-q', '-b', `tree-${runs}`, path, 'origin/main']);
      commit(path, file, text);
      return { path, start: git(path, ['rev-parse', 'HEAD']).trim() };
    };
    const target = (tree: { path: string; start: string }) =>
      baseMergeTarget(
        {
          base: 'main',
          push: openBranchPush({ git: runGit, clone: user, own: own() }),
          worktree: openWorktreeMerge({ git: runGit, clone: user }),
        },
        tree,
        'green',
      );
    const key = effectKey.encode(baseMergeKey(green));

    it('finds the merge a killed run made before it recorded it, and merges no second time', async () => {
      const tree = worktree();
      const base = mergeIntoMain('other.txt', 'other\n');
      assert.equal(await target(tree).find(key), undefined);
      const result = await target(tree).apply(key);
      const head = git(tree.path, ['rev-parse', 'HEAD']).trim();
      assert.deepEqual(result, { base, merged: head });
      assert.deepEqual(await target(tree).find(key), { result: { base, merged: head } });
      assert.equal(git(tree.path, ['rev-parse', 'HEAD']).trim(), head);
    });

    it("merges through the worktree's record under the clone, never by its .git file (ADR 0029)", async () => {
      const tree = worktree();
      const base = mergeIntoMain('other.txt', 'other\n');
      const elsewhere = git(other, ['rev-parse', 'HEAD']).trim();
      // A brewer pointed the worktree's .git file at a repository of its own. Git hides that file
      // on Windows, where writing over a hidden file is refused: it goes first.
      unlinkSync(join(tree.path, '.git'));
      writeFileSync(join(tree.path, '.git'), `gitdir: ${join(other, '.git')}\n`);
      const result = await target(tree).apply(key);
      const merged = git(user, ['rev-parse', `refs/heads/tree-${runs}`]).trim();
      assert.deepEqual(result, { base, merged });
      assert.deepEqual(git(user, ['rev-parse', `${merged}^1`]).trim(), tree.start);
      assert.equal(git(other, ['rev-parse', 'HEAD']).trim(), elsewhere);
    });

    it("throws with git's reason when the merge fails with nothing in conflict", async () => {
      const tree = worktree();
      mergeIntoMain('other.txt', 'other\n');
      // An untracked file the merge would overwrite: git refuses before it merges anything.
      writeFileSync(join(tree.path, 'other.txt'), 'mine\n');
      await assert.rejects(target(tree).apply(key), /^Error: git merge failed: /);
      assert.equal(git(tree.path, ['rev-parse', 'HEAD']).trim(), tree.start);
    });

    it('aborts a merge a killed run left in progress, and finds nothing', async () => {
      const tree = worktree('readme.txt', 'mine\n');
      mergeIntoMain('readme.txt', 'theirs\n');
      git(user, ['fetch', '-q', 'origin']);
      // A run killed in the middle of the merge leaves it in progress, with its conflicts.
      assert.throws(() => git(tree.path, ['merge', '--no-edit', 'origin/main']));
      assert.equal(await target(tree).find(key), undefined);
      assert.equal(git(tree.path, ['rev-parse', 'HEAD']).trim(), tree.start);
      assert.equal(git(tree.path, ['status', '--porcelain']), '');
    });
  });
});
