// The openPullRequest action's push with real git (ADR 0071): a bare origin and the user's clone,
// a batch brewed through openDriver whose brewer commits, and its task tree pushed to the bottle
// branch of the origin. The pull request goes to a fake code host: nothing reaches GitHub.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  type PullRequestHost,
  type PullRequestRequest,
  pullRequestActions,
} from '../../src/engine/pull-request-actions.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
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
  ale: fakeRecipe({
    steps: ['plan', 'open-pull-request'],
    actions: { 'open-pull-request': 'openPullRequest' },
    pullRequests: [],
  }),
});
const bottle = 'foedrum/acme.brewery/12-1/acme.app';
const url = 'https://github.com/acme/app/pull/1';

describe('the openPullRequest push with real git', () => {
  let dir: TempDir;
  let origin: string;
  let user: string;
  let store: EventStore;

  before(() => {
    dir = makeTempDir('pull-request-push');
  });
  after(() => removeTree(dir.path));
  let runs = 0;
  beforeEach(() => {
    const run = join(dir.path, String(++runs));
    const seed = join(run, 'seed');
    origin = join(run, 'origin.git');
    user = join(run, 'user');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'readme.txt'), 'hello\n');
    git(seed, ['add', 'readme.txt']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
    git(run, ['clone', '-q', '--bare', seed, origin]);
    git(run, ['clone', '-q', origin, user]);
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  /** The plan's work in its worktree, by default a commit of plan.txt. */
  const commitPlan = (path: string): void => {
    writeFileSync(join(path, 'plan.txt'), 'plan\n');
    git(path, ['add', 'plan.txt']);
    git(path, ['commit', '-q', '-m', 'Plan']);
  };

  /** Brews batch 12-1 of the ale recipe, whose plan does `work`, to the end of one tick. */
  const brew = async (work: (path: string) => void = commitPlan) => {
    const clock = () => new Date('2026-10-18T12:00:00.000Z');
    const requests: PullRequestRequest[] = [];
    const host: PullRequestHost = {
      find: async () => undefined,
      open: async (_repo, request) => {
        requests.push(request);
        return url;
      },
    };
    const reported: DriverNotice[] = [];
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
    const runner = fakeBrewerRunner(({ ref }) => {
      work(worktreeOf(ref));
      return behave.succeed();
    });
    driver = await openDriver({
      store,
      runner,
      recipes,
      clock,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      worktrees: [
        {
          repo: 'acme/app',
          base: 'origin/main',
          manager: openAttemptWorktrees({
            git: runGit,
            workRoot: join(dir.path, `work-${runs}`),
            repo: 'acme/app',
            clone: user,
          }),
        },
      ],
      actions: pullRequestActions({
        brewery: 'acme/brewery',
        repositories: [
          { repo: 'acme/app', base: 'main', push: openBranchPush({ git: runGit, clone: user }) },
        ],
        host,
        orderTitle: async () => 'Add a plan',
      }),
      report: (notice) => reported.push(notice),
    });
    try {
      const intake = createCommandLog({ store, recipes });
      intake.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, clock());
      const route = { kind: 'route', batchId: '12-1', recipe: 'ale', reason: 'label' } as const;
      intake.issue({ ...route, source: 'label' }, clock());
      await driver.tick();
      const plan = driver.state().batches.get('12-1')?.steps.get('plan')?.attempts.get(1);
      const planBranch = plan?.phase === 'finished' ? plan.worktree?.branch : undefined;
      return { state: driver.state(), requests, reported, planBranch };
    } finally {
      driver.close();
    }
  };

  it("pushes the plan's commit to the bottle branch of the origin and opens the pull request from it", async () => {
    const { state, requests, planBranch } = await brew();
    assert.ok(planBranch !== undefined);
    const tip = git(user, ['rev-parse', `refs/heads/${planBranch}`]).trim();
    assert.equal(git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim(), tip);
    assert.equal(git(origin, ['log', '-1', '--format=%s', `refs/heads/${bottle}`]).trim(), 'Plan');
    assert.deepEqual(
      requests.map(({ head, base, title }) => ({ head, base, title })),
      [{ head: bottle, base: 'main', title: 'Add a plan' }],
    );
    assert.deepEqual(state.batches.get('12-1')?.lane, { kind: 'on_tap', pullRequests: [url] });
    // Nothing else reached the origin: main is where it was, and no attempt branch was pushed.
    assert.deepEqual(
      git(origin, ['for-each-ref', '--format=%(refname)']).trim().split('\n').sort(),
      [`refs/heads/${bottle}`, 'refs/heads/main'],
    );
  });

  it('never forces: a bottle branch the origin has at another commit stops the push', async () => {
    // Someone pushed an unrelated commit to the bottle branch's name first.
    const other = join(dir.path, `other-${runs}`);
    git(dir.path, ['clone', '-q', origin, other]);
    git(other, ['commit', '-q', '--allow-empty', '-m', 'Unrelated']);
    git(other, ['push', '-q', 'origin', `HEAD:refs/heads/${bottle}`]);
    const unrelated = git(other, ['rev-parse', 'HEAD']).trim();
    const { state, requests, reported } = await brew();
    assert.equal(git(origin, ['rev-parse', `refs/heads/${bottle}`]).trim(), unrelated);
    assert.deepEqual(requests, []);
    assert.equal(state.batches.get('12-1')?.lane.kind, 'brewing');
    const failed = reported.find((notice) => notice.kind === 'effect_failed');
    assert.match(
      failed?.kind === 'effect_failed' ? (failed.error as Error).message : '',
      /^git push failed: /,
    );
  });

  it('pushes nothing for a plan that committed nothing while main moved on (review of #198)', async () => {
    const other = join(dir.path, `other-${runs}`);
    git(dir.path, ['clone', '-q', origin, other]);
    const { state, requests } = await brew(() => {
      // Someone merges into main while the plan runs, and the clone fetches it.
      git(other, ['commit', '-q', '--allow-empty', '-m', 'Merged meanwhile']);
      git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
      git(user, ['fetch', '-q', 'origin']);
    });
    assert.equal(git(origin, ['for-each-ref', '--format=%(refname)', `refs/heads/${bottle}`]), '');
    assert.deepEqual(requests, []);
    assert.equal(state.batches.get('12-1')?.lane.kind, 'stuck');
    const attempt = state.batches.get('12-1')?.steps.get('open-pull-request')?.attempts.get(1);
    assert.deepEqual(attempt?.phase === 'finished' && attempt.outcome, {
      kind: 'failed',
      retryable: false,
      reason: 'batch 12-1 has no commits beyond main to open a pull request with',
    });
  });

  describe('the secret scan before the push (ADR 0079)', () => {
    // Built at run time, so no scanner takes this file for one that holds a token.
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');

    /** Asserts that nothing reached the origin and the batch is Stuck on its environment; its summary. */
    const stopped = (state: Awaited<ReturnType<typeof brew>>['state'], requests: unknown[]) => {
      assert.equal(
        git(origin, ['for-each-ref', '--format=%(refname)', `refs/heads/${bottle}`]),
        '',
      );
      assert.deepEqual(requests, []);
      const lane = state.batches.get('12-1')?.lane;
      assert.equal(lane?.kind, 'stuck');
      const reason = lane?.kind === 'stuck' ? lane.reason : undefined;
      assert.equal(reason?.kind, 'blocked');
      assert.equal(reason?.kind === 'blocked' && reason.blockerKind, 'environment');
      // Not in any event, so neither on the state branch nor in the status comment.
      assert.doesNotMatch(JSON.stringify(store.eventsAfter(0)), /A1b2/);
      return reason?.kind === 'blocked' ? reason.summary : '';
    };

    /** Commits the token in plan.txt, then removes it again: the tip's tree holds no secret. */
    const commitAndHide = (path: string) => {
      writeFileSync(join(path, 'plan.txt'), `${token}\n`);
      git(path, ['add', 'plan.txt']);
      git(path, ['commit', '-q', '-m', 'Plan']);
      git(path, ['rm', '-q', 'plan.txt']);
      git(path, ['commit', '-q', '-m', 'Tidy']);
      const gitDir = git(path, ['rev-parse', '--git-common-dir']).trim();
      return {
        tidy: git(path, ['rev-parse', 'HEAD']).trim(),
        start: git(path, ['rev-parse', 'HEAD~2']).trim(),
        common: isAbsolute(gitDir) ? gitDir : join(path, gitDir),
      };
    };

    it('stops the push of a commit whose message holds a credential', async () => {
      const { state, requests, planBranch } = await brew((path) => {
        writeFileSync(join(path, 'plan.txt'), 'plan\n');
        git(path, ['add', 'plan.txt']);
        git(path, ['commit', '-q', '-m', 'Plan', '-m', `GH=${token}`]);
      });
      const tip = git(user, ['rev-parse', `refs/heads/${planBranch}`]).trim();
      assert.match(stopped(state, requests), new RegExp(`commit ${tip}, message: GitHub token`));
    });

    it('stops the push of a credential in an added line of a file the base has', async () => {
      const { state, requests } = await brew((path) => {
        writeFileSync(join(path, 'readme.txt'), `hello\nkey ${token}\n`);
        git(path, ['commit', '-q', '-am', 'Note the key']);
      });
      assert.match(stopped(state, requests), /, readme\.txt: GitHub token/);
    });

    it('stops the push of a credential in a new file, in a commit before the tip', async () => {
      const { state, requests } = await brew(commitAndHide);
      assert.match(stopped(state, requests), /, plan\.txt: GitHub token/);
    });

    it('stops the push of a binary file, which it cannot read', async () => {
      const { state, requests } = await brew((path) => {
        writeFileSync(join(path, 'logo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
        git(path, ['add', 'logo.png']);
        git(path, ['commit', '-q', '-m', 'Add a logo']);
      });
      assert.match(stopped(state, requests), /, logo\.png: binary file/);
    });

    it('stops the push of more than 4 MiB of changes, past what it reads', async () => {
      const { state, requests } = await brew((path) => {
        writeFileSync(join(path, 'big.txt'), 'all work and no play\n'.repeat(250_000));
        git(path, ['add', 'big.txt']);
        git(path, ['commit', '-q', '-m', 'Add a big file']);
      });
      assert.match(stopped(state, requests), /more than 4 MiB of messages or changes/);
    });

    // Each one hides the commit that adds the token from a plain `git log --patch` in the clone
    // every attempt worktree shares, while the push would still carry it.
    const plants: Record<string, (path: string) => void> = {
      'a replace ref that skips the commit': (path) => {
        const { tidy, start } = commitAndHide(path);
        git(path, ['replace', '--graft', tidy, start]);
      },
      'a graft that skips the commit': (path) => {
        const { tidy, start, common } = commitAndHide(path);
        mkdirSync(join(common, 'info'), { recursive: true });
        writeFileSync(join(common, 'info', 'grafts'), `${tidy} ${start}\n`);
      },
      'a shallow file that ends history at the tip': (path) => {
        const { tidy, common } = commitAndHide(path);
        writeFileSync(join(common, 'shallow'), `${tidy}\n`);
      },
      'a textconv that shows nothing': (path) => {
        const { common } = commitAndHide(path);
        mkdirSync(join(common, 'info'), { recursive: true });
        writeFileSync(join(common, 'info', 'attributes'), '*.txt diff=hide\n');
        git(path, ['config', 'diff.hide.textconv', 'node -e ""']);
      },
    };
    for (const [plant, work] of Object.entries(plants)) {
      it(`sees the commits as they are, whatever a brewer planted in the clone: ${plant}`, async () => {
        const { state, requests } = await brew(work);
        assert.match(stopped(state, requests), /, plan\.txt: GitHub token/);
      });
    }
  });
});
