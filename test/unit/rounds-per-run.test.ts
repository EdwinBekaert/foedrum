// A route's rounds per run of the recipe (ADR 0369): an `onFindings` or `onFail` route counts the
// attempts it scheduled since the batch's latest recipe choice or rewind, so a later run gets its
// own `maxRounds`; an `onPullRequestFail` route counts over the batch's life, since its rounds
// belong to the one pull request. The recipes are the loaded ones, the command log the real one on
// a store in memory (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Lane } from '../../src/engine/fold.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { HeadCheck } from '../../src/schemas/events.ts';
import type { PushResult } from '../../src/schemas/store.ts';
import { recipeText } from '../helpers/brewery-files.ts';

const url = 'https://github.com/acme/web/pull/12';
const now = new Date('2026-11-10T09:00:00.000Z');
const batchId = 'web-7';
const by = { by: 'ann', via: 'terminal' } as const;

const building = (name: string, steps: readonly unknown[]) => ({
  path: `recipes/${name}.jsonc`,
  text: recipeText(name, steps, { testFirst: false }),
});
const loaded = loadRecipes({
  ...readBreweryFiles(join(import.meta.dirname, '..', '..', 'no-brewery')),
  recipes: [
    // A plan reviewed by one Taster, whose findings go back to the plan once.
    building('tasted', [
      { id: 'plan', brewer: 'brewmaster' },
      {
        id: 'taste',
        brewer: 'taster',
        lens: 'plan/naive-reader',
        onFindings: { goto: 'plan', maxRounds: 1 },
      },
    ]),
    // A change whose test check sends it back to the implementation once.
    building('checked', [
      { id: 'implement', brewer: 'cellarman' },
      { id: 'green', check: 'test', onFail: { goto: 'implement', maxRounds: 1 } },
      { id: 'open', action: 'openPullRequest' },
    ]),
    // A change whose pull request's failing checks send it back once.
    building('fixed', [
      { id: 'implement', brewer: 'cellarman' },
      {
        id: 'open',
        action: 'openPullRequest',
        onPullRequestFail: { goto: 'implement', maxRounds: 1 },
      },
    ]),
  ],
});
if (!loaded.valid) throw new Error(loaded.problems.join('\n'));
const { recipes } = loaded;

const done: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const blocked: Ending = {
  kind: 'blocked',
  blockerKind: 'findings',
  summary: 'The plan skips a step',
  findings: [
    {
      point: 'Fix this.',
      severity: 'major',
      why: 'A step is missing',
      introduced: true,
      file: 'plan.md',
      line: 3,
    },
  ],
};
const ended: Ending = { kind: 'failed', retryable: true, reason: 'the session ended' };
const failedCheck: Ending = { kind: 'failed', retryable: false, reason: 'test failed' };
const failing: HeadCheck = {
  name: 'ci/build',
  kind: 'check_run',
  conclusion: 'failure',
  url: 'https://github.com/acme/web/actions/runs/1',
};

describe("a route's rounds per run of the recipe (ADR 0369)", () => {
  let store: EventStore;
  let log: CommandLog;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const lane = (): Lane | undefined => log.state().batches.get(batchId)?.lane;
  const latest = (stepId: string) => {
    const attempts = log.state().batches.get(batchId)?.steps.get(stepId)?.attempts;
    return attempts?.get(Math.max(...(attempts?.keys() ?? [])));
  };
  /** The scheduled attempt of `stepId`, started and ended with `ending`. */
  const run = (stepId: string, ending: Ending): void => {
    const attempt = latest(stepId);
    assert.equal(attempt?.phase, 'scheduled', `${stepId} is scheduled`);
    const ref = { batchId, stepId, attempt: attempt.attempt };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    accept({ kind: 'finish', ...ref, ending });
  };
  const routed = (recipe: string): void => {
    accept({ kind: 'order', batchId, order: { issue: 7 } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
  };
  const choose = (recipe: string): void =>
    accept({ kind: 'recipe', batchId, recipe, reason: 'a person chose', ...by });
  const rewind = (toStepId: string): void =>
    accept({ kind: 'rewind', batchId, toStepId, shas: { 'acme/web': 'd'.repeat(40) }, ...by });
  /** tasted's plan, then its Taster blocking on findings each time it runs, as often as `times`. */
  const tastedRun = (times: number): void => {
    run('plan', done);
    for (let round = 1; round < times; round++) {
      run('taste', blocked);
      assert.equal(latest('plan')?.phase, 'scheduled', 'the findings sent the plan back');
      run('plan', done);
    }
    run('taste', blocked);
  };
  const stuckRounds = (): number | undefined => {
    const now = lane();
    assert.equal(now?.kind, 'stuck', JSON.stringify(now));
    return now?.kind === 'stuck' && now.reason.kind === 'blocked'
      ? now.reason.roundsOut?.rounds
      : undefined;
  };

  it('a batch whose run used its round back, run again from Stuck by a recipe choice, gets a round back in its next run', () => {
    routed('tasted');
    tastedRun(2);
    assert.equal(stuckRounds(), 1);
    choose('tasted');
    run('plan', done);
    run('taste', blocked);
    assert.equal(lane()?.kind, 'brewing');
    assert.equal(latest('plan')?.phase, 'scheduled');
    assert.deepStrictEqual(latest('plan')?.route, { from: 'taste', why: 'findings' });
  });

  it("a rewind gives the route its rounds again from the rewind's point", () => {
    routed('tasted');
    tastedRun(2);
    rewind('plan');
    run('plan', done);
    run('taste', blocked);
    assert.equal(lane()?.kind, 'brewing');
    assert.deepStrictEqual(latest('plan')?.route, { from: 'taste', why: 'findings' });
  });

  it('rounds used in the current run still count toward maxRounds', () => {
    routed('tasted');
    tastedRun(2);
    choose('tasted');
    tastedRun(2);
    assert.equal(stuckRounds(), 1);
  });

  it('counts a round whose attempt is scheduled and not yet on the path: regression test', () => {
    routed('tasted');
    tastedRun(2);
    choose('tasted');
    run('plan', done);
    run('taste', blocked);
    const batch = log.state().batches.get(batchId);
    assert.equal(latest('plan')?.phase, 'scheduled');
    assert.ok(batch !== undefined);
    assert.equal(recipes.find('tasted')?.rounds(batch, 'taste', 'findings'), 1);
  });

  it("counts a run's rounds from its goto step's first attempt, not the sending step's: regression test", () => {
    routed('tasted');
    run('plan', done);
    // A retry in each round leaves taste two attempts ahead of plan when the run ends.
    run('taste', ended);
    run('taste', blocked);
    run('plan', done);
    run('taste', ended);
    run('taste', blocked);
    assert.equal(stuckRounds(), 1);
    choose('tasted');
    tastedRun(2);
    assert.equal(stuckRounds(), 1);
  });

  it("counts the goto step's first attempt of a run when its route scheduled it: regression test", () => {
    routed('tasted');
    tastedRun(2);
    // A rewind past plan: plan's first attempt of the run is the one the route schedules.
    rewind('taste');
    run('taste', blocked);
    assert.deepStrictEqual(latest('plan')?.route, { from: 'taste', why: 'findings' });
    run('plan', done);
    run('taste', blocked);
    assert.equal(stuckRounds(), 1);
  });

  it("counts in no later run a route's attempt that its deadline abandoned before it started", () => {
    routed('tasted');
    run('plan', done);
    run('taste', blocked);
    const sent = latest('plan');
    assert.equal(sent?.phase, 'scheduled');
    assert.deepStrictEqual(sent.route, { from: 'taste', why: 'findings' });
    const due = new Date(Date.parse(sent.deadlineAt) + 1);
    const expired = log.issue(
      { kind: 'expire', batchId, stepId: 'plan', attempt: sent.attempt },
      due,
    );
    assert.equal(expired.kind, 'accepted', JSON.stringify(expired));
    assert.equal(lane()?.kind, 'stuck');
    rewind('plan');
    run('plan', done);
    run('taste', blocked);
    assert.equal(lane()?.kind, 'brewing');
    assert.deepStrictEqual(latest('plan')?.route, { from: 'taste', why: 'findings' });
  });

  it('an onFail route gets its round back after a rewind', () => {
    routed('checked');
    run('implement', done);
    run('green', failedCheck);
    run('implement', done);
    run('green', failedCheck);
    assert.equal(lane()?.kind, 'stuck');
    rewind('implement');
    run('implement', done);
    run('green', failedCheck);
    assert.equal(lane()?.kind, 'brewing');
    assert.deepStrictEqual(latest('implement')?.route, { from: 'green', why: 'failed' });
  });

  describe('an onPullRequestFail route', () => {
    const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
      accept({
        kind: 'record',
        event: { type: 'effect.applied', key: effectKey.encode(key), result },
      });
    /**
     * The open action of the batch, its push of `round` at `head` recorded unless the ledger has it
     * (`round` undefined), then its checks on `head` failed, recorded unless they are already.
     */
    const openedAndFailed = (round: number | undefined, head: string): void => {
      const attempt = latest('open');
      assert.equal(attempt?.phase, 'scheduled', 'open is scheduled');
      const ref = { batchId, stepId: 'open', attempt: attempt.attempt };
      accept({ kind: 'record', event: { type: 'step.started', ...ref } });
      const pushed: PushResult = { branch: 'foedrum/web-7/acme.web', commit: head, from: 'start' };
      if (round !== undefined) ledger(pushKey(batchId, round), pushed);
      if (round === 1) ledger(pullRequestKey(batchId), url);
      accept({ kind: 'finish', ...ref, ending: done });
      if (round !== undefined)
        accept({
          kind: 'record',
          event: {
            type: 'pull_request.checks_finished',
            batchId,
            pullRequest: url,
            head,
            checks: [failing],
          },
        });
      accept({
        kind: 'fix_pull_request',
        batchId,
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
    };

    it('stays out of rounds after a rewind once its rounds ran out: regression test', () => {
      routed('fixed');
      run('implement', done);
      openedAndFailed(1, 'a'.repeat(40));
      assert.equal(lane()?.kind, 'brewing', 'the first failure goes back');
      run('implement', done);
      openedAndFailed(2, 'b'.repeat(40));
      assert.equal(lane()?.kind, 'stuck');
      rewind('implement');
      run('implement', done);
      // The task tree pushed at round 2 is recorded already: the rewind's own push is refused (ADR 0219).
      openedAndFailed(undefined, 'b'.repeat(40));
      const after = lane();
      assert.equal(after?.kind, 'stuck', JSON.stringify(after));
      assert.equal(after?.kind === 'stuck' ? after.reason.kind : undefined, 'pull_request_failed');
    });
  });
});
