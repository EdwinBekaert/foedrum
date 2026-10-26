// stop (#518, ADR 0205): a person's stop of an order makes each of its brewing batches Stuck with
// reason `stopped`, recorded with who, from where and why; its unfinished attempts are abandoned,
// so the driver stops their runs at its next tick, and `retry` schedules the step again.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import {
  type CommandLog,
  createCommandLog,
  defaultReminderMs,
} from '../../src/engine/command-log.ts';
import type { Command, Ending } from '../../src/engine/decide.ts';
import { openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { pauseOf } from '../../src/engine/pauses.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T12:00:00.000Z');
const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 1 }),
  tasting: fakeRecipe({ steps: ['plan', 'taste', 'open'], groups: { taste: ['a', 'b'] } }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const who = { by: 'ada', via: 'terminal' } as const;

describe('stop (ADR 0205)', () => {
  let store: EventStore;
  let log: CommandLog;
  let now: Date;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    now = t0;
  });
  afterEach(() => store.close());

  const issue = (command: Command) => log.issue(command, now);
  const accept = (command: Command) => {
    const decision = issue(command);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    return decision.kind === 'accepted' ? decision.events : [];
  };
  const refuse = (command: Command, reason: RegExp) => {
    const decision = issue(command);
    assert.equal(decision.kind, 'refused', JSON.stringify(decision));
    if (decision.kind === 'refused') assert.match(decision.reason, reason);
  };
  /** Orders issue `n` of the Brewery as batch `b<n>` and routes it to `recipe`. */
  const order = (n: number, recipe = 'pint', repo?: string): string => {
    const batchId = repo === undefined ? `b${n}` : `web-${n}-1`;
    accept({
      kind: 'order',
      batchId,
      order: repo === undefined ? { issue: n } : { issue: n, repo },
    });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    return batchId;
  };
  const batch = (batchId: string): Batch => {
    const found = log.state().batches.get(batchId);
    assert.ok(found, `batch ${batchId}`);
    return found;
  };
  const start = (batchId: string, stepId = 'plan', attempt = 1) =>
    accept({ kind: 'record', event: { type: 'step.started', batchId, stepId, attempt } });
  const decompose = () => {
    accept({
      kind: 'record',
      event: {
        type: 'order.decomposed',
        batchId: 'b12',
        subOrders: [{ issue: 30, repo: 'acme/api' }],
        dependencies: [],
      },
    });
    accept({ kind: 'order', batchId: 'b30', order: { issue: 30 }, parentBatchId: 'b12' });
    accept({ kind: 'route', batchId: 'b30', recipe: 'pint', reason: 'label', source: 'label' });
  };

  it('makes a brewing batch Stuck stopped at its running step, with who, from where and why', () => {
    order(12);
    start('b12');
    const events = accept({ kind: 'stop', order: { issue: 12 }, ...who, why: 'wrong way' });
    assert.deepStrictEqual(events, [
      {
        type: 'batch.stuck',
        batchId: 'b12',
        reason: { kind: 'stopped', stepId: 'plan', by: 'ada', via: 'terminal', why: 'wrong way' },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: new Date(t0.getTime() + defaultReminderMs).toISOString(),
      },
    ]);
    const attempt = batch('b12').steps.get('plan')?.attempts.get(1);
    assert.equal(attempt?.phase === 'started' && attempt.abandoned, true);
  });

  it('makes a batch with nothing running Stuck too, at the step that was due', () => {
    order(12);
    accept({ kind: 'stop', order: { issue: 12 }, ...who });
    const { lane } = batch('b12');
    assert.equal(lane.kind, 'stuck');
    if (lane.kind === 'stuck') {
      assert.deepStrictEqual(lane.reason, {
        kind: 'stopped',
        stepId: 'plan',
        by: 'ada',
        via: 'terminal',
      });
    }
  });

  it("stops the order's sub-orders' batches with its own, and no other order's", () => {
    order(12);
    order(13);
    decompose();
    const events = accept({ kind: 'stop', order: { issue: 12 }, ...who });
    assert.deepStrictEqual(
      events.map((event) => ('batchId' in event ? event.batchId : '')),
      ['b12', 'b30'],
    );
    assert.equal(batch('b13').lane.kind, 'brewing');
  });

  it('leaves an Ordered and a Stuck batch of the order as they are', () => {
    order(12);
    start('b12');
    accept({
      kind: 'finish',
      batchId: 'b12',
      stepId: 'plan',
      attempt: 1,
      ending: { kind: 'failed', retryable: true, reason: 'tests fail' },
    });
    assert.equal(batch('b12').lane.kind, 'stuck');
    accept({ kind: 'order_again', batchId: 'b12-2', order: { issue: 99 }, ...who });
    refuse(
      { kind: 'stop', order: { issue: 12 }, ...who },
      /^there is no brewing batch of #12 to stop$/,
    );
    refuse(
      { kind: 'stop', order: { issue: 99 }, ...who },
      /^there is no brewing batch of #99 to stop$/,
    );
    const { lane } = batch('b12');
    assert.equal(lane.kind === 'stuck' && lane.reason.kind, 'attempts_exhausted');
  });

  it('is refused for an order with no batch, and when its batches ended', () => {
    refuse(
      { kind: 'stop', order: { issue: 40 }, ...who },
      /^there is no brewing batch of #40 to stop$/,
    );
    order(12);
    accept({ kind: 'cancel', batchId: 'b12', ...who });
    refuse(
      { kind: 'stop', order: { issue: 12 }, ...who },
      /^there is no brewing batch of #12 to stop$/,
    );
  });

  it('is refused for a sub-order, or the order of a claimed issue, naming the order to stop', () => {
    order(12);
    decompose();
    refuse({ kind: 'stop', order: { issue: 30 }, ...who }, /^#30 is a sub-order of #12; stop #12$/);
    // web-7-1's Brewery issue, the order its driver opened, is #40 (ADR 0144).
    const batchId = order(7, 'pint', 'acme/web');
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: `["${batchId}","order.issue"]`, result: 40 },
    });
    refuse(
      { kind: 'stop', order: { issue: 40 }, ...who },
      /^#40 is the order of web#7; stop web#7$/,
    );
  });

  it("stops a claimed target issue's batches by their repository, in any case", () => {
    const batchId = order(7, 'pint', 'acme/web');
    order(7);
    accept({ kind: 'stop', order: { issue: 7, repo: 'Acme/Web' }, ...who });
    assert.equal(batch(batchId).lane.kind, 'stuck');
    assert.equal(batch('b7').lane.kind, 'brewing');
  });

  it('refuses the end of the attempt it stopped: the stop spends no attempt', () => {
    order(12);
    start('b12');
    accept({ kind: 'stop', order: { issue: 12 }, ...who });
    refuse(
      { kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: { kind: 'cancelled' } },
      /abandoned/,
    );
  });

  describe('retry', () => {
    it('schedules the stopped step again as a retry, though it had used its attempts', () => {
      order(12);
      start('b12');
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      const events = accept({ kind: 'retry', batchId: 'b12', by: 'grace', via: 'plugin' });
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ['batch.resumed', 'step.scheduled'],
      );
      assert.deepStrictEqual(events[1], {
        type: 'step.scheduled',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 2,
        deadlineAt: new Date(t0.getTime() + 60 * minute).toISOString(),
        retry: true,
      });
      assert.equal(batch('b12').lane.kind, 'brewing');
    });

    it("resumes a parallel group's children that had not ended", () => {
      order(12, 'tasting');
      start('b12');
      accept({ kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: succeeded });
      start('b12', 'a');
      start('b12', 'b');
      accept({ kind: 'finish', batchId: 'b12', stepId: 'a', attempt: 1, ending: succeeded });
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      const { lane } = batch('b12');
      assert.equal(
        lane.kind === 'stuck' && lane.reason.kind === 'stopped' && lane.reason.stepId,
        'b',
      );
      const events = accept({ kind: 'retry', batchId: 'b12', ...who });
      assert.deepStrictEqual(
        events.flatMap((event) => (event.type === 'step.scheduled' ? [event.stepId] : [])),
        ['b'],
      );
    });

    it('names a running child of a group when two run, and the retry resumes the other', () => {
      order(12, 'tasting');
      start('b12');
      accept({ kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: succeeded });
      start('b12', 'a');
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      const events = accept({ kind: 'retry', batchId: 'b12', ...who });
      assert.deepStrictEqual(
        events.flatMap((event) => (event.type === 'step.scheduled' ? [event.stepId] : [])).sort(),
        ['a', 'b'],
      );
    });
  });

  describe('and a pause', () => {
    it('leaves the pause of the batch it stops, so the retried step waits for continue', () => {
      order(12);
      start('b12');
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      assert.equal(batch('b12').lane.kind, 'stuck');
      assert.notEqual(pauseOf(log.state(), batch('b12')), undefined);
      accept({ kind: 'retry', batchId: 'b12', ...who });
      assert.notEqual(pauseOf(log.state(), batch('b12')), undefined);
    });

    it('lets a pause hold a stopped batch', () => {
      order(12);
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      assert.notEqual(pauseOf(log.state(), batch('b12')), undefined);
    });
  });

  it("is stopped by the driver at its next tick, and the retry's attempt runs", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const running = new Map<string, (end: AttemptEnd) => void>();
    const runner: BrewerRunner = {
      start: ({ ref }: { ref: AttemptRef }) => {
        const key = attemptKey.encode(ref);
        started.push(key);
        const ended = new Promise<AttemptEnd>((end) => running.set(key, end));
        return {
          ended,
          stop: () => {
            stopped.push(key);
            running.get(key)?.({ ending: { kind: 'cancelled' } });
            running.delete(key);
          },
        };
      },
      progress: () => ({ lastProgressAt: now, turnsWithoutProgress: 0 }),
    };
    const driver = await openDriver({
      store,
      runner,
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
    });
    try {
      order(12);
      await driver.tick();
      assert.equal(started.length, 1);
      assert.deepStrictEqual(stopped, []);
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      now = new Date(now.getTime() + minute);
      await driver.tick();
      assert.deepStrictEqual(stopped, started);
      assert.equal(batch('b12').lane.kind, 'stuck');
      accept({ kind: 'retry', batchId: 'b12', ...who });
      now = new Date(now.getTime() + minute);
      await driver.tick();
      assert.equal(started.length, 2);
    } finally {
      driver.close();
    }
  });
});
