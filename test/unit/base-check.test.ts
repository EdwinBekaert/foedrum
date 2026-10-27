// The check of the Brewery's open pull requests when their base moves (ADR 0198): a fake
// repository answers the base's tip and the merge-tree, a fake GitHub takes the comments, and the
// command log is the real one on a store in memory (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  type BaseCheckRepository,
  baseConflictEffects,
  checkBases,
  conflictPosts,
  type MergeTreeResult,
} from '../../src/engine/base-check.ts';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import type { MergedCheckDue } from '../../src/engine/merged-checks.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { baseCheckLines, renderStatus } from '../../src/engine/status-comment.ts';
import type { GravityReading } from '../../src/schemas/events.ts';
import { MAX_CONFLICTS, type PushResult } from '../../src/schemas/store.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const web = 'acme/web';
const pullRequest = 'https://github.com/acme/web/pull/12';
const other = 'https://github.com/acme/web/pull/13';
const now = new Date('2026-10-25T09:00:00.000Z');
const head = 'a'.repeat(40);
const green = 'b'.repeat(40);
const tip1 = 'c'.repeat(40);
const tip2 = 'd'.repeat(40);
const tip3 = 'e'.repeat(40);
const recipes = fakeRecipes({
  half: fakeRecipe({ steps: ['plan'], pullRequests: [pullRequest] }),
  twice: fakeRecipe({ steps: ['plan'], pullRequests: [other] }),
  // A batch on tap with a second pull request beside the one its ledger opened.
  both: fakeRecipe({ steps: ['plan'], pullRequests: [other, pullRequest] }),
  // Two steps that each merged the base, as two check attempts would (ADR 0164).
  again: fakeRecipe({ steps: ['plan', 'green'], pullRequests: [pullRequest] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

/** A repository whose base's tip is `tips.at` and whose merge-tree answers by tip. */
const fakeRepository = (answers: Record<string, MergeTreeResult | Error>) => {
  // The base's tip, and the bottle branch's tip on the remote: the pushed head until a person pushes.
  const state = { at: tip1 as string | Error, branch: head as string | undefined };
  const calls: string[] = [];
  const branchCalls: string[] = [];
  const repository: BaseCheckRepository = {
    repo: web,
    base: 'main',
    tip: async (base) => {
      calls.push(`tip ${base}`);
      if (state.at instanceof Error) throw state.at;
      return state.at;
    },
    mergeTree: async (from, tip) => {
      calls.push(`merge-tree ${from.slice(0, 1)} ${tip.slice(0, 1)}`);
      const answer = answers[tip];
      if (answer === undefined) throw new Error(`no answer for ${tip}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    branchTip: async (branch) => {
      branchCalls.push(branch);
      return state.branch;
    },
  };
  return { repository, calls, state, branchCalls };
};

const conflicts = (...files: string[]): MergeTreeResult => ({ kind: 'conflicts', files });
const clean: MergeTreeResult = { kind: 'clean' };

describe('checkBases', () => {
  let store: EventStore;
  let log: CommandLog;
  let failures: { what: string; error: unknown }[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    failures = [];
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
    assert.equal(log.issue(command, now).kind, 'accepted');
  const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode(key), result },
    });
  /** `batchId` on tap with the pull request its ledger opened and the commit its push recorded. */
  const onTap = (
    batchId = 'web-7',
    recipe = 'half',
    url = pullRequest,
    issue = 7,
    { repo = web, merges = [green] }: { repo?: string; merges?: string[] } = {},
  ): void => {
    accept({ kind: 'order', batchId, order: { issue, repo } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    for (const [n, stepId] of (recipe === 'again' ? ['plan', 'green'] : ['plan']).entries()) {
      const ref = { batchId, stepId, attempt: 1 };
      accept({ kind: 'record', event: { type: 'step.started', ...ref } });
      // The base its check merged before the push (ADR 0164).
      const base = merges[n];
      if (base !== undefined) ledger({ ...ref, effect: 'merge_base' }, { base });
      accept({ kind: 'finish', ...ref, ending: succeeded });
    }
    const pushed: PushResult = { branch: 'foedrum/x/acme.web', commit: head, from: 'start' };
    ledger(pushKey(batchId), pushed);
    ledger(pullRequestKey(batchId), url);
  };
  const batch = (batchId = 'web-7'): Batch => {
    const found = log.state().batches.get(batchId);
    assert.ok(found);
    return found;
  };
  const pass = (repository: BaseCheckRepository) =>
    checkBases(
      {
        log,
        repositories: [repository],
        clock: () => now,
        failed: (what, error) => failures.push({ what, error }),
      },
      new AbortController().signal,
    );

  it('records a moved tip that conflicts, posts it once, and checks the same tip no more', async () => {
    onTap();
    const { repository, calls } = fakeRepository({ [tip1]: conflicts('src/a.ts', 'src/b.ts') });
    await pass(repository);
    await pass(repository);
    assert.deepStrictEqual(batch().baseChecks, [
      { pullRequest, branch: 'main', tip: tip1, head, conflicts: ['src/a.ts', 'src/b.ts'] },
    ]);
    assert.deepStrictEqual(
      calls.filter((call) => call.startsWith('merge-tree')),
      ['merge-tree a c'],
    );
    assert.deepStrictEqual(
      conflictPosts(batch()).map(({ n, check }) => [n, check.tip]),
      [[1, tip1]],
    );
    assert.deepStrictEqual(failures, []);
  });

  it('checks a new tip again; the same files post nothing, other files post again', async () => {
    onTap();
    const { repository, state } = fakeRepository({
      [tip1]: conflicts('src/a.ts'),
      [tip2]: conflicts('src/a.ts'),
      [tip3]: conflicts('src/a.ts', 'src/c.ts'),
    });
    await pass(repository);
    state.at = tip2;
    await pass(repository);
    state.at = tip3;
    await pass(repository);
    assert.deepStrictEqual(
      batch().baseChecks?.map(({ tip }) => tip),
      [tip1, tip2, tip3],
    );
    assert.deepStrictEqual(
      conflictPosts(batch()).map(({ n, check }) => [n, check.tip]),
      [
        [1, tip1],
        [2, tip3],
      ],
    );
  });

  it('records a clean merge and posts nothing; a conflict that comes back after it posts again', async () => {
    onTap();
    const { repository, state } = fakeRepository({
      [tip1]: clean,
      [tip2]: conflicts('src/a.ts'),
      [tip3]: clean,
    });
    await pass(repository);
    assert.deepStrictEqual(batch().baseChecks, [{ pullRequest, branch: 'main', tip: tip1, head }]);
    assert.deepStrictEqual(conflictPosts(batch()), []);
    assert.deepStrictEqual(baseCheckLines(batch()), []);
    state.at = tip2;
    await pass(repository);
    state.at = tip3;
    await pass(repository);
    assert.deepStrictEqual(
      conflictPosts(batch()).map(({ n, check }) => [n, check.tip]),
      [[1, tip2]],
    );
  });

  it('runs no merge-tree when the tip is the base the batch last merged', async () => {
    onTap();
    const { repository, calls, state } = fakeRepository({});
    state.at = green;
    await pass(repository);
    assert.deepStrictEqual(calls, ['tip main']);
    assert.equal(batch().baseChecks, undefined);
  });

  it('reads each base once per pass, however many pull requests go into it', async () => {
    onTap();
    onTap('web-8', 'twice', other, 8);
    const { repository, calls } = fakeRepository({ [tip1]: clean });
    await pass(repository);
    assert.deepStrictEqual(calls, ['tip main', 'merge-tree a c', 'merge-tree a c']);
  });

  it('records nothing when the tip or the merge-tree fails, and tries again on the next pass', async () => {
    onTap();
    const broken = new Error('fatal: unable to access');
    const { repository, calls, state } = fakeRepository({ [tip1]: new Error('bad object') });
    state.at = broken;
    await pass(repository);
    state.at = tip1;
    await pass(repository);
    assert.equal(batch().baseChecks, undefined);
    assert.deepStrictEqual(conflictPosts(batch()), []);
    assert.deepStrictEqual(calls, ['tip main', 'tip main', 'merge-tree a c']);
    assert.deepStrictEqual(
      failures.map(({ what, error }) => [what, (error as Error).message]),
      [
        [`reading the tip of main in ${web}`, 'fatal: unable to access'],
        [`merging ${pullRequest} with main at ${tip1}`, 'bad object'],
      ],
    );
  });

  it('checks no pull request whose end is recorded', async () => {
    onTap();
    accept({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state: 'merged' },
    });
    const { repository, calls } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
    await pass(repository);
    assert.deepStrictEqual(calls, []);
  });

  it('records nothing for a pass given up at its deadline', async () => {
    onTap();
    const controller = new AbortController();
    const { repository } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
    const late: BaseCheckRepository = {
      ...repository,
      mergeTree: async (from, tip, signal) => {
        controller.abort(new Error('late'));
        return repository.mergeTree(from, tip, signal);
      },
    };
    await checkBases(
      { log, repositories: [late], clock: () => now, failed: () => {} },
      controller.signal,
    );
    assert.equal(batch().baseChecks, undefined);
  });

  it('refuses a check of a pull request the batch did not open', () => {
    onTap();
    const refused = log.issue(
      {
        kind: 'record',
        event: {
          type: 'pull_request.base_checked',
          batchId: 'web-7',
          pullRequest: other,
          branch: 'main',
          tip: tip1,
        },
      },
      now,
    );
    assert.equal(refused.kind, 'refused');
  });

  it('checks no more once someone else pushed to the bottle branch: no merge-tree, no comment, and the status comment says so', async () => {
    onTap();
    const { repository, calls, state, branchCalls } = fakeRepository({
      [tip1]: conflicts('src/a.ts'),
      [tip2]: conflicts('src/b.ts'),
    });
    await pass(repository);
    state.branch = 'f'.repeat(40);
    state.at = tip2;
    await pass(repository);
    state.at = tip3;
    await pass(repository);
    assert.deepStrictEqual(
      calls.filter((call) => call.startsWith('merge-tree')),
      ['merge-tree a c'],
    );
    assert.deepStrictEqual(branchCalls, ['foedrum/x/acme.web', 'foedrum/x/acme.web']);
    assert.deepStrictEqual(batch().baseChecks?.at(-1), {
      pullRequest,
      branch: 'main',
      tip: tip2,
      head,
      branchMoved: 'f'.repeat(40),
    });
    assert.equal(batch().baseChecks?.length, 2);
    assert.deepStrictEqual(
      conflictPosts(batch()).map(({ n }) => n),
      [1],
    );
    assert.deepStrictEqual(baseCheckLines(batch()), [
      `- <${pullRequest}> is not checked against \`main\` since someone else pushed to its branch`,
    ]);
  });

  it('records nothing for a bottle branch the remote no longer has: the end comes next', async () => {
    onTap();
    const { repository, calls, state } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
    state.branch = undefined;
    await pass(repository);
    assert.deepStrictEqual(calls, ['tip main']);
    assert.equal(batch().baseChecks, undefined);
    assert.deepStrictEqual(failures, []);
  });

  it("reports a bottle branch's tip it cannot read, records nothing, and reads it again next pass", async () => {
    onTap();
    const { repository, calls, branchCalls } = fakeRepository({ [tip1]: clean });
    const broken: BaseCheckRepository = {
      ...repository,
      branchTip: async (branch, signal) => {
        await repository.branchTip(branch, signal);
        throw new Error('fatal: could not read from remote repository');
      },
    };
    await pass(broken);
    await pass(broken);
    assert.deepStrictEqual(calls, ['tip main', 'tip main']);
    assert.equal(branchCalls.length, 2);
    assert.equal(batch().baseChecks, undefined);
    assert.deepStrictEqual(
      failures.map(({ what, error }) => [what, (error as Error).message]),
      Array(2).fill([
        'reading the tip of foedrum/x/acme.web in acme/web',
        'fatal: could not read from remote repository',
      ]),
    );
  });

  it("reads the bottle branch's tip only when the base's tip moved", async () => {
    onTap();
    const { repository, branchCalls } = fakeRepository({ [tip1]: clean });
    await pass(repository);
    await pass(repository);
    assert.deepStrictEqual(branchCalls, ['foedrum/x/acme.web']);
  });

  it("compares with the base the batch's latest merge read, not an earlier one", async () => {
    onTap('web-7', 'again', pullRequest, 7, { merges: [green, tip2] });
    const { repository, calls, state } = fakeRepository({});
    state.at = tip2;
    await pass(repository);
    assert.deepStrictEqual(calls, ['tip main']);
  });

  it('records at most MAX_CONFLICTS files of a conflict, the first ones', async () => {
    onTap();
    const files = Array.from({ length: MAX_CONFLICTS + 1 }, (_, n) => `src/f${n}.ts`);
    await pass(fakeRepository({ [tip1]: conflicts(...files) }).repository);
    assert.deepStrictEqual(batch().baseChecks?.[0]?.conflicts, files.slice(0, MAX_CONFLICTS));
    assert.deepStrictEqual(failures, []);
  });

  it('reads a tip that failed once per pass, however many pull requests wait for it', async () => {
    onTap();
    onTap('web-8', 'twice', other, 8);
    const { repository, calls, state } = fakeRepository({});
    state.at = new Error('fatal: unable to access');
    await pass(repository);
    assert.deepStrictEqual(calls, ['tip main']);
    assert.equal(failures.length, 1);
  });

  it('passes over a batch of a repository it has no base check for, and checks the others', async () => {
    onTap('api-3', 'twice', other, 3, { repo: 'acme/api' });
    onTap();
    const { repository, calls } = fakeRepository({ [tip1]: clean });
    await pass(repository);
    assert.deepStrictEqual(calls, ['tip main', 'merge-tree a c']);
    assert.equal(batch('api-3').baseChecks, undefined);
    assert.equal(batch().baseChecks?.length, 1);
    assert.deepStrictEqual(failures, []);
  });

  it('runs no merge-tree and records nothing when the pass is given up while it reads the tip', async () => {
    onTap();
    const controller = new AbortController();
    const { repository, calls } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
    const late: BaseCheckRepository = {
      ...repository,
      tip: async (base, signal) => {
        controller.abort(new Error('late'));
        return repository.tip(base, signal);
      },
    };
    await checkBases(
      { log, repositories: [late], clock: () => now, failed: () => {} },
      controller.signal,
    );
    assert.deepStrictEqual(calls, ['tip main']);
    assert.equal(batch().baseChecks, undefined);
  });

  it('reports a check the log refuses, as another writer ending the pull request between would', async () => {
    onTap();
    const { repository } = fakeRepository({ [tip1]: clean });
    const refusing: CommandLog = {
      ...log,
      issue: () => ({ kind: 'refused', reason: 'pull request ended' }),
    };
    await checkBases(
      {
        log: refusing,
        repositories: [repository],
        clock: () => now,
        failed: (what, error) => failures.push({ what, error }),
      },
      new AbortController().signal,
    );
    assert.deepStrictEqual(
      failures.map(({ what, error }) => [what, (error as Error).message]),
      [[`recording the check of ${pullRequest}`, 'pull request ended']],
    );
  });

  it('posts nothing again for the same files named in another order', async () => {
    onTap();
    const { repository, state } = fakeRepository({
      [tip1]: conflicts('src/a.ts', 'src/b.ts'),
      [tip2]: conflicts('src/b.ts', 'src/a.ts'),
    });
    await pass(repository);
    state.at = tip2;
    await pass(repository);
    assert.equal(batch().baseChecks?.length, 2);
    assert.deepStrictEqual(
      conflictPosts(batch()).map(({ n }) => n),
      [1],
    );
  });

  describe('the checks on the merged tree (ADR 0203)', () => {
    /** The run's side of the hand-off: whether the batch has checks, and each due run. */
    const handing = (wants = true) => {
      const handed: MergedCheckDue[] = [];
      const checks = { wants: () => wants, due: (due: MergedCheckDue) => void handed.push(due) };
      return { handed, checks };
    };

    it('hands a clean merge of a moved tip to the run, once per pass, and records nothing', async () => {
      onTap();
      const { repository } = fakeRepository({ [tip1]: clean });
      const { handed, checks } = handing();
      await pass({ ...repository, checks });
      assert.equal(batch().baseChecks, undefined);
      assert.deepStrictEqual(handed, [
        // With how many checks it had then: a check recorded after drops the run (review of #528).
        { batchId: 'web-7', pullRequest, branch: 'main', tip: tip1, head, checked: 0 },
      ]);
      // Nothing recorded yet: the next pass hands it on again, which the run's queue takes once.
      await pass({ ...repository, checks });
      assert.equal(handed.length, 2);
    });

    it("counts only the handed-on pull request's own checks", async () => {
      onTap('web-7', 'both');
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.base_checked',
          batchId: 'web-7',
          pullRequest: other,
          branch: 'main',
          tip: tip2,
          conflicts: ['src/b.ts'],
        },
      });
      const { repository } = fakeRepository({ [tip1]: clean });
      const { handed, checks } = handing();
      await pass({ ...repository, checks });
      assert.deepStrictEqual(
        handed.map((due) => [due.pullRequest, due.checked]),
        [[pullRequest, 0]],
      );
    });

    it('records a clean merge as before when the batch has no checks to run', async () => {
      onTap();
      const { repository } = fakeRepository({ [tip1]: clean });
      const { handed, checks } = handing(false);
      await pass({ ...repository, checks });
      assert.deepStrictEqual(batch().baseChecks, [
        { pullRequest, branch: 'main', tip: tip1, head },
      ]);
      assert.deepStrictEqual(handed, []);
    });

    it('runs no check for a conflict: it is recorded as before', async () => {
      onTap();
      const { repository } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
      const { handed, checks } = handing();
      await pass({ ...repository, checks });
      assert.deepStrictEqual(handed, []);
      assert.deepStrictEqual(batch().baseChecks, [
        { pullRequest, branch: 'main', tip: tip1, head, conflicts: ['src/a.ts'] },
      ]);
    });

    it('hands nothing on for a tip whose run is recorded, until the tip moves', async () => {
      onTap();
      const { repository, state } = fakeRepository({ [tip1]: clean, [tip2]: clean });
      const { handed, checks } = handing();
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.base_checked',
          batchId: 'web-7',
          pullRequest,
          branch: 'main',
          tip: tip1,
          unchecked: 'the worktree could not be made',
        },
      });
      await pass({ ...repository, checks });
      assert.deepStrictEqual(handed, []);
      state.at = tip2;
      await pass({ ...repository, checks });
      assert.deepStrictEqual(
        handed.map(({ tip, checked }) => [tip, checked]),
        [[tip2, 1]],
      );
    });
  });

  describe('the status comment', () => {
    it('shows no base check of a pull request that ended', async () => {
      onTap();
      const { repository } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
      await pass(repository);
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state: 'merged' },
      });
      assert.deepStrictEqual(baseCheckLines(batch()), []);
      const text = renderStatus(batch());
      assert.ok(text.includes(`- <${pullRequest}>`), text);
      assert.doesNotMatch(text, /conflicts with/);
    });

    it('shows the latest check: the tip and files of a conflict, then that it merges cleanly again', async () => {
      onTap();
      const { repository, state } = fakeRepository({
        [tip1]: conflicts('src/a.ts', 'src/b_c.ts'),
        [tip2]: clean,
      });
      await pass(repository);
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> conflicts with \`main\` at \`cccccccc\` in src/a.ts, src/b\\_c.ts`,
      ]);
      const text = renderStatus(batch());
      assert.ok(text.includes(baseCheckLines(batch())[0] ?? 'missing'), text);
      state.at = tip2;
      await pass(repository);
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> merges cleanly with \`main\` again at \`dddddddd\``,
      ]);
      assert.ok(renderStatus(batch()).includes('merges cleanly with `main` again'));
    });

    const checked = (tip: string, found: Record<string, unknown> = {}): void =>
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.base_checked',
          batchId: 'web-7',
          pullRequest,
          branch: 'main',
          tip,
          ...found,
        },
      } as Parameters<CommandLog['issue']>[0]);
    const failing: GravityReading = {
      result: 'exited',
      check: 'test',
      command: 'npm test',
      exitCode: 1,
      tail: 'not ok 1 - adds',
    };

    it('shows a failing check on the merged tree with its name and how it failed, then that it passes again', () => {
      onTap();
      checked(tip1, { failed: failing });
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> fails on the merged tree with \`main\` at \`cccccccc\`: the check "test" (npm test) failed with exit code 1`,
      ]);
      assert.ok(renderStatus(batch()).includes('fails on the merged tree'));
      checked(tip2);
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> passes its checks on the merged tree with \`main\` again at \`dddddddd\``,
      ]);
    });

    it('shows a setup that failed on the merged tree, and why checks did not run', () => {
      onTap();
      checked(tip1, {
        failed: { result: 'exited', setup: true, command: 'npm ci', exitCode: 2, tail: '' },
      });
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> fails on the merged tree with \`main\` at \`cccccccc\`: the setup "npm ci" failed with exit code 2`,
      ]);
      checked(tip2, { unchecked: 'git worktree add failed: fatal: *disk* full' });
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> is not checked on the merged tree with \`main\` at \`dddddddd\`: git worktree add failed: fatal: \\*disk\\* full`,
      ]);
      checked(tip3);
      assert.deepStrictEqual(baseCheckLines(batch()), [
        `- <${pullRequest}> passes its checks on the merged tree with \`main\` again at \`eeeeeeee\``,
      ]);
    });

    it('says how each kind of reading failed on the merged tree, a literal command by its line', () => {
      const ran = { check: 'test', command: 'npm test', tail: '' } as const;
      const cases: [GravityReading, string][] = [
        [{ result: 'signaled', ...ran, signal: 'SIGSEGV' }, 'was ended by SIGSEGV'],
        [{ result: 'unstarted', ...ran }, 'could not start'],
        [{ result: 'killed', ...ran, killed: 'timed-out' }, 'did not finish by its deadline'],
        [
          { result: 'killed', ...ran, killed: 'too-much-output' },
          "wrote more output than the process runner's limit",
        ],
        [{ result: 'killed', ...ran, killed: 'stopped' }, 'was stopped'],
      ];
      onTap();
      for (const [n, [reading, how]] of cases.entries()) {
        checked(String(n).repeat(40).slice(0, 40), { failed: reading });
        assert.match(
          baseCheckLines(batch())[0] ?? '',
          new RegExp(`: the check "test" \\(npm test\\) ${how.replace(/[.()]/g, '\\$&')}$`),
        );
      }
      checked(tip1, { failed: { result: 'exited', command: 'make e2e', exitCode: 2, tail: '' } });
      assert.match(
        baseCheckLines(batch())[0] ?? '',
        /: the check "make e2e" failed with exit code 2$/,
      );
    });

    it('keeps the failure and the reason on the fold of the check', () => {
      onTap();
      checked(tip1, { failed: failing });
      checked(tip2, { unchecked: 'no worktree' });
      assert.deepStrictEqual(batch().baseChecks, [
        { pullRequest, branch: 'main', tip: tip1, failed: failing },
        { pullRequest, branch: 'main', tip: tip2, unchecked: 'no worktree' },
      ]);
    });
  });

  describe('baseConflictEffects', () => {
    it('comments once on the pull request for each post, found by its marker', async () => {
      onTap();
      const { repository } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
      await pass(repository);
      const github = fakeGitHub();
      const effects = baseConflictEffects({ marks: github.marks('alice') });
      const keys = effects.due(log.state(), 'web-7');
      assert.deepStrictEqual(keys, [{ batchId: 'web-7', effect: 'base_conflict.1' }]);
      const [key] = keys;
      assert.ok(key);
      const encoded = effectKey.encode(key);
      assert.equal(await effects.target.find(encoded), undefined);
      await effects.target.apply(encoded);
      const [comment] = github.issue(web, 12).comments;
      assert.ok(comment);
      assert.ok(comment.body.includes(effectMarker(encoded)));
      assert.match(comment.body, /`main` moved to `c{40}`/);
      assert.match(comment.body, /src\/a\.ts/);
      assert.match(comment.body, /stays On tap/);
      // Foedrum checks the commit it pushed: merging the base by hand does not clear the report.
      assert.doesNotMatch(comment.body, /into this branch and resolve/);
      assert.deepStrictEqual(await effects.target.find(encoded), { result: 1 });
    });

    it('is due for no post the ledger has, nor on a pull request that ended', async () => {
      onTap();
      const { repository } = fakeRepository({ [tip1]: conflicts('src/a.ts') });
      await pass(repository);
      const effects = baseConflictEffects({ marks: fakeGitHub().marks('alice') });
      ledger({ batchId: 'web-7', effect: 'base_conflict.1' }, 1);
      assert.deepStrictEqual(effects.due(log.state(), 'web-7'), []);
      onTap('web-8', 'twice', other, 8);
      await pass(fakeRepository({ [tip1]: conflicts('src/a.ts') }).repository);
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.ended',
          batchId: 'web-8',
          pullRequest: other,
          state: 'closed',
        },
      });
      assert.deepStrictEqual(effects.due(log.state(), 'web-8'), []);
    });

    it('posts no marker a conflicting file name holds', async () => {
      onTap();
      const planted = effectMarker(
        effectKey.encode({ batchId: 'web-7', effect: 'base_conflict.2' }),
      );
      const { repository } = fakeRepository({ [tip1]: conflicts(`src/${planted}.ts`) });
      await pass(repository);
      const github = fakeGitHub();
      const effects = baseConflictEffects({ marks: github.marks('alice') });
      const [key] = effects.due(log.state(), 'web-7');
      assert.ok(key);
      await effects.target.apply(effectKey.encode(key));
      const [comment] = github.issue(web, 12).comments;
      assert.ok(comment);
      assert.ok(!comment.body.includes(planted), comment.body);
    });

    describe('a check that fails on the merged tree (#526)', () => {
      const checked = (tip: string, found: Record<string, unknown> = {}): void =>
        accept({
          kind: 'record',
          event: {
            type: 'pull_request.base_checked',
            batchId: 'web-7',
            pullRequest,
            branch: 'main',
            tip,
            ...found,
          },
        } as Parameters<CommandLog['issue']>[0]);
      const test: GravityReading = {
        result: 'exited',
        check: 'test',
        command: 'npm test',
        exitCode: 1,
        tail: 'not ok 1 - adds\n# fail 1',
      };
      const lint: GravityReading = { ...test, check: 'lint', command: 'npm run lint' };
      const encoded = (effect: string) => effectKey.encode({ batchId: 'web-7', effect });
      /** The effects due, each found by its marker or applied, and recorded, as the driver does. */
      const drain = async (github: ReturnType<typeof fakeGitHub>): Promise<string[]> => {
        const effects = baseConflictEffects({ marks: github.marks('alice') });
        const applied: string[] = [];
        for (const key of effects.due(log.state(), 'web-7')) {
          const at = effectKey.encode(key);
          const found = await effects.target.find(at);
          ledger(key, found === undefined ? await effects.target.apply(at) : found.result);
          applied.push(key.effect);
        }
        return applied;
      };
      const bodies = (github: ReturnType<typeof fakeGitHub>) =>
        github.issue(web, 12).comments.map(({ body }) => body);

      it('posts a first failure once, naming the check and the tip, with the tail in a fence', async () => {
        onTap();
        checked(tip1, { failed: test });
        const github = fakeGitHub();
        assert.deepStrictEqual(await drain(github), ['base_check_failed.1']);
        assert.deepStrictEqual(await drain(github), []);
        const [body, ...rest] = bodies(github);
        assert.ok(body);
        assert.deepStrictEqual(rest, []);
        assert.match(body, /^### Foedrum · batch `web-7`/);
        assert.ok(
          body.includes('`main` moved to `cccccccccccccccccccccccccccccccccccccccc`'),
          body,
        );
        assert.ok(body.includes('the check "test" (npm test) failed with exit code 1'), body);
        assert.ok(body.includes('```\nnot ok 1 - adds\n# fail 1\n```'), body);
        assert.match(body, /stays On tap/);
        assert.ok(body.includes(effectMarker(encoded('base_check_failed.1'))));
      });

      it('posts nothing when the same check fails again, and again when another check fails', async () => {
        onTap();
        checked(tip1, { failed: test });
        checked(tip2, { failed: { ...test, exitCode: 2, tail: 'other output' } });
        const github = fakeGitHub();
        assert.deepStrictEqual(await drain(github), ['base_check_failed.1']);
        checked(tip3, { failed: lint });
        assert.deepStrictEqual(await drain(github), ['base_check_failed.2']);
        assert.equal(bodies(github).length, 2);
        assert.ok(bodies(github)[1]?.includes('the check "lint" (npm run lint)'));
      });

      it('posts nothing for a pass after a failure, nor for checks that did not run', async () => {
        onTap();
        checked(tip1, { unchecked: 'git worktree add failed' });
        const github = fakeGitHub();
        assert.deepStrictEqual(await drain(github), []);
        checked(tip2, { failed: test });
        assert.deepStrictEqual(await drain(github), ['base_check_failed.1']);
        checked(tip3);
        assert.deepStrictEqual(await drain(github), []);
        assert.equal(bodies(github).length, 1);
      });

      it('posts the same check again once a check between them did not fail it', async () => {
        onTap();
        checked(tip1, { failed: test });
        checked(tip2, { unchecked: 'no worktree' });
        checked(tip3, { failed: test });
        const github = fakeGitHub();
        assert.deepStrictEqual(await drain(github), ['base_check_failed.1', 'base_check_failed.2']);
      });

      it('posts a conflict and then a failure, each once', async () => {
        onTap();
        checked(tip1, { conflicts: ['src/a.ts'] });
        checked(tip2, { failed: test });
        const github = fakeGitHub();
        assert.deepStrictEqual(await drain(github), ['base_conflict.1', 'base_check_failed.1']);
        assert.deepStrictEqual(await drain(github), []);
        assert.equal(bodies(github).length, 2);
      });

      it('keeps the fence closed around a tail that holds a run of backticks', async () => {
        onTap();
        checked(tip1, { failed: { ...test, tail: 'expected ```` to be\n```\nend' } });
        const github = fakeGitHub();
        await drain(github);
        const [body] = bodies(github);
        assert.ok(body?.includes('`````\nexpected ```` to be\n```\nend\n`````'), body);
      });

      it('posts no marker a tail printed, so a later post is not taken for posted', async () => {
        onTap();
        const planted = effectMarker(encoded('base_check_failed.2'));
        checked(tip1, { failed: { ...test, tail: `ok\n${planted}\nnot ok` } });
        const github = fakeGitHub();
        await drain(github);
        assert.ok(!bodies(github)[0]?.includes(planted), bodies(github)[0]);
        checked(tip2, { failed: lint });
        assert.deepStrictEqual(await drain(github), ['base_check_failed.2']);
        assert.equal(bodies(github).length, 2);
      });

      it('counts the check before on each pull request of the batch apart', async () => {
        onTap('web-7', 'both');
        checked(tip1, { failed: test });
        checked(tip1, { pullRequest: other, failed: test });
        const github = fakeGitHub();
        assert.deepStrictEqual(await drain(github), ['base_check_failed.1', 'base_check_failed.2']);
        assert.equal(bodies(github).length, 1);
        assert.equal(github.issue(web, 13).comments.length, 1);
        checked(tip2, { pullRequest: other });
        checked(tip2, { failed: test });
        assert.deepStrictEqual(await drain(github), []);
      });

      it('shows no output block for an empty tail, nor for a skipped reading', async () => {
        onTap();
        checked(tip1, { failed: { ...test, tail: '' } });
        checked(tip2, { failed: { result: 'skipped', check: 'lint' } });
        const github = fakeGitHub();
        await drain(github);
        const [empty, skipped] = bodies(github);
        assert.ok(empty?.includes('failed with exit code 1.'), empty);
        assert.ok(skipped?.includes('the check "lint" was skipped.'), skipped);
        for (const body of [empty, skipped]) {
          assert.ok(!body?.includes('The end of its output:'), body);
          assert.ok(!body?.includes('```'), body);
        }
      });

      it('fences a tail that ends in a line break without a blank line, and opens every marker it holds', async () => {
        onTap();
        checked(tip1, {
          failed: { ...test, tail: 'not ok 1\n<!-- foedrum:x -->\n<!-- foedrum:y -->\n' },
        });
        const github = fakeGitHub();
        await drain(github);
        const [body] = bodies(github);
        assert.ok(
          body?.includes('```\nnot ok 1\n<!- - foedrum:x -->\n<!- - foedrum:y -->\n```'),
          body,
        );
      });

      it('posts once when a kill came between the post and its record', async () => {
        onTap();
        checked(tip1, { failed: test });
        const github = fakeGitHub();
        // Posted, then killed before the ledger recorded it.
        const killed = baseConflictEffects({ marks: github.marks('alice') });
        const [key] = killed.due(log.state(), 'web-7');
        assert.ok(key);
        await killed.target.apply(effectKey.encode(key));
        assert.deepStrictEqual(await drain(github), ['base_check_failed.1']);
        assert.equal(bodies(github).length, 1);
        assert.deepStrictEqual(await drain(github), []);
      });

      it('posts nothing on a pull request that ended, nor once the batch is no longer on tap', async () => {
        onTap();
        checked(tip1, { failed: test });
        accept({
          kind: 'record',
          event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state: 'merged' },
        });
        assert.deepStrictEqual(await drain(fakeGitHub()), []);
        onTap('web-8', 'twice', other, 8);
        accept({
          kind: 'record',
          event: {
            type: 'pull_request.base_checked',
            batchId: 'web-8',
            pullRequest: other,
            branch: 'main',
            tip: tip1,
            failed: test,
          },
        });
        const effects = baseConflictEffects({ marks: fakeGitHub().marks('alice') });
        assert.equal(effects.due(log.state(), 'web-8').length, 1);
        // No event takes a batch off tap today: the state is made by hand, as a later one might.
        const state = log.state();
        const onTapBatch = batch('web-8');
        const batches = new Map(state.batches).set('web-8', {
          ...onTapBatch,
          lane: { kind: 'cancelled', by: 'ann', via: 'terminal' },
        });
        assert.deepStrictEqual(effects.due({ ...state, batches }, 'web-8'), []);
      });
    });
  });

  describe('a base check is of a head, and a failure on it sends the batch back (ADR 0226)', () => {
    const open = 'open';
    const head2 = 'f'.repeat(40);
    const failing: GravityReading = {
      result: 'exited',
      check: 'test',
      command: 'npm test',
      exitCode: 1,
      tail: 'not ok 1 - adds',
    };
    const fixed = fakeRecipes({
      // Nip's shape: the openPullRequest step goes back to plan, at most two rounds.
      fixed: fakeRecipe({
        steps: ['plan', open],
        actions: { [open]: 'openPullRequest' },
        routes: { [open]: { pull_request: 'plan' } },
        maxRounds: 2,
        pullRequests: [],
      }),
      half: fakeRecipe({ steps: ['plan'], pullRequests: [pullRequest] }),
    });
    let fixLog: CommandLog;
    beforeEach(() => {
      fixLog = createCommandLog({ store, recipes: fixed });
    });
    const take = (command: Parameters<CommandLog['issue']>[0]): void => {
      const decision = fixLog.issue(command, now);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    };
    const record = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
      take({
        kind: 'record',
        event: { type: 'effect.applied', key: effectKey.encode(key), result },
      });
    const pushedAt = (commit: string): PushResult => ({
      branch: 'foedrum/x/acme.web',
      commit,
      from: 'start',
    });
    /** Batch web-7 of `fixed`: plan, then the action pushed `head` and opened the pull request. */
    const onTapFixed = (): void => {
      take({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      take({ kind: 'route', batchId: 'web-7', recipe: 'fixed', reason: 'label', source: 'label' });
      for (const stepId of ['plan', open]) {
        const ref = { batchId: 'web-7', stepId, attempt: 1 };
        take({ kind: 'record', event: { type: 'step.started', ...ref } });
        if (stepId === open) {
          record(pushKey('web-7'), pushedAt(head));
          record(pullRequestKey('web-7'), pullRequest);
        }
        take({ kind: 'finish', ...ref, ending: succeeded });
      }
    };
    const failedAt = (tip: string, of = head): void =>
      take({
        kind: 'record',
        event: {
          type: 'pull_request.base_checked',
          batchId: 'web-7',
          pullRequest,
          branch: 'main',
          tip,
          head: of,
          failed: failing,
        },
      });
    const fixCommand = (tip: string, of = head) =>
      ({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest,
        head: of,
        cause: { kind: 'merged_check', tip },
      }) as const;
    /** The fix round: plan#2 merged the base at `merged` at its start, and the action pushed `next`. */
    const fixRoundTo = (next: string, merged: string): void => {
      const planRef = { batchId: 'web-7', stepId: 'plan', attempt: 2 };
      take({ kind: 'record', event: { type: 'step.started', ...planRef } });
      record({ ...planRef, effect: 'merge_base' }, { base: merged, merged: 'b'.repeat(40) });
      take({ kind: 'finish', ...planRef, ending: succeeded });
      const openRef = { batchId: 'web-7', stepId: open, attempt: 2 };
      take({ kind: 'record', event: { type: 'step.started', ...openRef } });
      record(pushKey('web-7', 2), pushedAt(next));
      take({ kind: 'finish', ...openRef, ending: succeeded });
    };
    const fixedBatch = (): Batch => {
      const found = fixLog.state().batches.get('web-7');
      assert.ok(found);
      return found;
    };
    const fixedPass = (repository: BaseCheckRepository) =>
      checkBases(
        {
          log: fixLog,
          repositories: [repository],
          clock: () => now,
          failed: (what, error) => failures.push({ what, error }),
        },
        new AbortController().signal,
      );
    /** The posts due, each found by its marker or applied, and recorded, as the driver does. */
    const drain = async (github: ReturnType<typeof fakeGitHub>): Promise<string[]> => {
      const effects = baseConflictEffects({ marks: github.marks('alice'), recipes: fixed });
      const applied: string[] = [];
      for (const key of effects.due(fixLog.state(), 'web-7')) {
        const at = effectKey.encode(key);
        const found = await effects.target.find(at);
        record(key, found === undefined ? await effects.target.apply(at) : found.result);
        applied.push(key.effect);
      }
      return applied;
    };

    it('checks a fixed head only once the base moves past what its round merged, on the new head', async () => {
      onTapFixed();
      failedAt(tip1);
      take(fixCommand(tip1));
      fixRoundTo(head2, tip1);
      assert.equal(fixedBatch().lane.kind, 'on_tap');
      const { repository, calls, state } = fakeRepository({ [tip1]: clean, [tip2]: clean });
      state.branch = head2;
      await fixedPass(repository);
      assert.deepStrictEqual(
        calls.filter((call) => call.startsWith('merge-tree')),
        [],
      );
      state.at = tip2;
      await fixedPass(repository);
      assert.deepStrictEqual(
        calls.filter((call) => call.startsWith('merge-tree')),
        ['merge-tree f d'],
      );
      assert.deepStrictEqual(fixedBatch().baseChecks?.at(-1), {
        pullRequest,
        branch: 'main',
        tip: tip2,
        head: head2,
      });
    });

    it("shows no failure of the old head on the fixed head's status line", () => {
      onTapFixed();
      failedAt(tip1);
      assert.match(baseCheckLines(fixedBatch(), head)[0] ?? '', /fails on the merged tree/);
      take(fixCommand(tip1));
      fixRoundTo(head2, tip1);
      assert.deepStrictEqual(baseCheckLines(fixedBatch(), head2), []);
      const text = renderStatus(
        fixedBatch(),
        undefined,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        head2,
      );
      assert.doesNotMatch(text, /fails on the merged tree/);
    });

    it('posts the failure saying Foedrum fixes it, also once the tick sent the batch back first', async () => {
      onTapFixed();
      failedAt(tip1);
      take(fixCommand(tip1));
      assert.equal(fixedBatch().lane.kind, 'brewing');
      const github = fakeGitHub();
      assert.deepStrictEqual(await drain(github), ['base_check_failed.1']);
      assert.deepStrictEqual(await drain(github), []);
      const [body] = github.issue(web, 12).comments.map((comment) => comment.body);
      assert.ok(body);
      assert.match(body, /Foedrum sends the batch back to fix it, at most 2 rounds/);
      assert.doesNotMatch(body, /stays On tap/);
    });
  });
});
