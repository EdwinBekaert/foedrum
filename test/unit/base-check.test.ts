// The check of the Brewery's open pull requests when their base moves (ADR 0198): a fake
// repository answers the base's tip and the merge-tree, a fake GitHub takes the comments, and the
// command log is the real one on a store in memory (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  type BaseCheckRepository,
  baseCheckLines,
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
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { PushResult } from '../../src/schemas/store.ts';
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
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

/** A repository whose base's tip is `tips.at` and whose merge-tree answers by tip. */
const fakeRepository = (answers: Record<string, MergeTreeResult | Error>) => {
  const state = { at: tip1 as string | Error };
  const calls: string[] = [];
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
  };
  return { repository, calls, state };
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
  const onTap = (batchId = 'web-7', recipe = 'half', url = pullRequest, issue = 7): void => {
    accept({ kind: 'order', batchId, order: { issue, repo: web } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    const ref = { batchId, stepId: 'plan', attempt: 1 };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    // The base green merged before the push (ADR 0164).
    ledger({ ...ref, effect: 'merge_base' }, { base: green });
    accept({ kind: 'finish', ...ref, ending: succeeded });
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
      { pullRequest, branch: 'main', tip: tip1, conflicts: ['src/a.ts', 'src/b.ts'] },
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
    assert.deepStrictEqual(batch().baseChecks, [{ pullRequest, branch: 'main', tip: tip1 }]);
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

  describe('the status comment', () => {
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
  });
});
