// One run of the checks on an open pull request's merged tree (ADR 0203): a fake tree and a fake
// check runner, and the command log on a store in memory (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { CheckTree, TreeIn } from '../../src/checks/check-runner.ts';
import { mergedCheckRun } from '../../src/cli/merged-check-run.ts';
import type { ServeSetup } from '../../src/cli/serve-config.ts';
import type { AttemptEnd } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { MergedCheckDue } from '../../src/engine/merged-checks.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { MergedTree } from '../../src/workspace/merge-tree-git.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const now = new Date('2026-10-26T09:00:00.000Z');
const url = 'https://github.com/acme/web/pull/12';
const head = 'a'.repeat(40);
const tip = 'c'.repeat(40);
const merged = '/work/acme.web/git-dirs/one.tree';
// green's own deadline, under the run's cap.
const GREEN_MS = 30 * 60_000;
const recipes = fakeRecipes({
  nip: { ...fakeRecipe({ steps: ['green'], merges: ['green'] }), deadlineMs: () => GREEN_MS },
});
const checks: StepChecks = {
  find: (_recipe, stepId) => (stepId === 'green' ? ['test'] : undefined),
  any: () => true,
  proves: () => undefined,
  redProof: () => undefined,
};
const repositories = [{ repo: 'acme/web' }] as unknown as ServeSetup['repositories'];
const due: MergedCheckDue = {
  batchId: 'web-7',
  pullRequest: url,
  branch: 'main',
  tip,
  head,
  checked: 0,
};

describe('mergedCheckRun', () => {
  let store: EventStore;
  let log: CommandLog;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    log.issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, now);
    log.issue(
      { kind: 'route', batchId: 'web-7', recipe: 'nip', reason: 'label', source: 'label' },
      now,
    );
  });
  afterEach(() => store.close());

  /** A run whose check runner answers `end`, and what it was asked. */
  const runWith = (end: AttemptEnd) => {
    const asked: { refs: readonly unknown[]; tree: TreeIn; deadlineAt: string }[] = [];
    const trees: string[] = [];
    const tree = (): MergedTree => async (from, to, use) => {
      trees.push(`${from} ${to}`);
      return use(merged);
    };
    const checkTree: CheckTree = async (refs, worktree, deadlineAt) => {
      asked.push({ refs, tree: worktree, deadlineAt });
      return end;
    };
    return {
      asked,
      trees,
      run: mergedCheckRun({
        setup: { recipes, checks, repositories },
        log,
        tree,
        checkTree,
        clock: () => now,
      }),
    };
  };
  const live = new AbortController().signal;

  it("reads the step's checks in the merged tree's worktree, by the step's own deadline", async () => {
    const { asked, trees, run } = runWith({ ending: { kind: 'succeeded', output: null } });
    assert.deepStrictEqual(await run(due, live), { kind: 'passed' });
    assert.deepStrictEqual(trees, [`${head} ${tip}`]);
    assert.deepStrictEqual(asked, [
      {
        refs: ['test'],
        tree: { repo: 'acme/web', path: merged },
        deadlineAt: new Date(now.getTime() + GREEN_MS).toISOString(),
      },
    ]);
  });

  it('ends stopped when the stop ended it, whatever its readings, and when the runner was cancelled', async () => {
    const stopped: AttemptEnd = {
      ending: { kind: 'cancelled' },
      readings: [
        { result: 'killed', check: 'test', command: 'npm test', killed: 'stopped', tail: '' },
      ],
    };
    const stop = new AbortController();
    stop.abort();
    assert.deepStrictEqual(await runWith(stopped).run(due, stop.signal), { kind: 'stopped' });
    assert.deepStrictEqual(await runWith({ ending: { kind: 'cancelled' } }).run(due, live), {
      kind: 'stopped',
    });
  });

  it('ends failed with the first reading that did not pass', async () => {
    const failing = {
      result: 'exited',
      check: 'test',
      command: 'npm test',
      exitCode: 1,
      tail: 'not ok 1',
    } as const;
    const end: AttemptEnd = {
      ending: { kind: 'failed', retryable: false, reason: 'the check "test" failed' },
      readings: [{ result: 'skipped', check: 'lint' }, failing],
    };
    assert.deepStrictEqual(await runWith(end).run(due, live), {
      kind: 'failed',
      reading: failing,
    });
  });

  it('ends unchecked, with why, when the runner read nothing that failed and did not pass', async () => {
    const blocked: AttemptEnd = {
      ending: {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'foedrum.jsonc lists no checks of acme/web for the check "test"',
      },
    };
    assert.deepStrictEqual(await runWith(blocked).run(due, live), {
      kind: 'unchecked',
      why: 'foedrum.jsonc lists no checks of acme/web for the check "test"',
    });
    const failed: AttemptEnd = {
      ending: { kind: 'failed', retryable: true, reason: 'no worktree to read' },
    };
    assert.deepStrictEqual(await runWith(failed).run(due, live), {
      kind: 'unchecked',
      why: 'no worktree to read',
    });
  });

  it('ends unchecked without a tree for a batch the log has not, or without a step that merges its base', async () => {
    const { trees, run } = runWith({ ending: { kind: 'succeeded', output: null } });
    assert.deepStrictEqual(await run({ ...due, batchId: 'gone-1' }, live), {
      kind: 'unchecked',
      why: 'batch gone-1 has no check step that merges its base',
    });
    log.issue({ kind: 'order', batchId: 'web-8', order: { issue: 8, repo: 'acme/web' } }, now);
    assert.equal((await run({ ...due, batchId: 'web-8' }, live)).kind, 'unchecked');
    assert.deepStrictEqual(trees, []);
  });
});
