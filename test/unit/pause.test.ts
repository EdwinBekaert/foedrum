// pause and continue (ADR 0202): a person's pause of an order, or of the whole Brewery, recorded
// with who and why; no new attempt of a paused batch starts, a scheduled attempt that has not
// started waits without its deadline and gets a new one on continue, and an attempt the pause
// stopped at its stopAt counts against no retry.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command, Ending } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { pauseOf, stopAtText, stopsNow } from '../../src/engine/pauses.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { planTick } from '../../src/engine/supervisor.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2 }),
  tasting: fakeRecipe({ steps: ['plan', 'taste', 'open'], groups: { taste: ['a', 'b'] } }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const who = { by: 'ada', via: 'terminal' } as const;

describe('pause and continue (ADR 0202)', () => {
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
    assert.equal(decision.kind, 'refused');
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
  const deadlineOf = (batchId: string, stepId: string, attempt: number): string | undefined => {
    const attempt_ = batch(batchId).steps.get(stepId)?.attempts.get(attempt);
    return attempt_?.deadlineAt;
  };

  describe('pause', () => {
    it('records who paused an order, from where, why and when what runs is stopped', () => {
      order(12);
      const events = accept({
        kind: 'pause',
        order: { issue: 12 },
        ...who,
        why: 'end of the day',
        stopAt: { at: at(90), zone: 'Europe/Brussels' },
      });
      assert.deepStrictEqual(events, [
        {
          type: 'order.paused',
          order: { issue: 12 },
          by: 'ada',
          via: 'terminal',
          why: 'end of the day',
          stopAt: at(90).toISOString(),
          zone: 'Europe/Brussels',
        },
      ]);
      assert.deepStrictEqual(pauseOf(log.state(), batch('b12')), {
        by: 'ada',
        via: 'terminal',
        why: 'end of the day',
        stopAt: { at: at(90).toISOString(), zone: 'Europe/Brussels' },
      });
    });

    it("holds the batches of the order it names and of that order's sub-orders, and no other", () => {
      order(12);
      order(13);
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
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      assert.notEqual(pauseOf(log.state(), batch('b12')), undefined);
      assert.notEqual(pauseOf(log.state(), batch('b30')), undefined);
      assert.equal(pauseOf(log.state(), batch('b13')), undefined);
    });

    it("holds a claimed target issue's batches by their repository, in any case", () => {
      const batchId = order(7, 'pint', 'acme/web');
      order(7);
      accept({ kind: 'pause', order: { issue: 7, repo: 'Acme/Web' }, ...who });
      assert.notEqual(pauseOf(log.state(), batch(batchId)), undefined);
      assert.equal(pauseOf(log.state(), batch('b7')), undefined);
    });

    it('holds every batch with --all, those ordered after it too', () => {
      order(12);
      accept({ kind: 'pause', ...who });
      // The intake orders nothing under --all; a person's own order is not held.
      accept({ kind: 'order_again', batchId: 'b13', order: { issue: 13 }, ...who });
      assert.notEqual(pauseOf(log.state(), batch('b12')), undefined);
      assert.notEqual(pauseOf(log.state(), batch('b13')), undefined);
    });

    it('holds no batch that ended', () => {
      order(12);
      accept({ kind: 'pause', ...who });
      accept({ kind: 'cancel', batchId: 'b12', ...who });
      assert.equal(pauseOf(log.state(), batch('b12')), undefined);
    });

    it('is refused for an order with no batch that has not ended', () => {
      refuse({ kind: 'pause', order: { issue: 40 }, ...who }, /no batch of #40 that has not ended/);
      order(12);
      accept({ kind: 'cancel', batchId: 'b12', ...who });
      refuse({ kind: 'pause', order: { issue: 12 }, ...who }, /no batch of #12 that has not ended/);
    });

    it('replaces an earlier pause of the same order, so --by can be added later', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({
        kind: 'pause',
        order: { issue: 12 },
        by: 'grace',
        via: 'plugin',
        stopAt: { at: at(20), zone: 'UTC' },
      });
      assert.deepStrictEqual(pauseOf(log.state(), batch('b12')), {
        by: 'grace',
        via: 'plugin',
        stopAt: { at: at(20).toISOString(), zone: 'UTC' },
      });
    });

    it('is kept by a new command log on the same store, as after a restart', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      const restarted = createCommandLog({ store, recipes });
      const b12 = restarted.state().batches.get('b12');
      assert.ok(b12);
      assert.notEqual(pauseOf(restarted.state(), b12), undefined);
    });

    it('stops what runs only once its stopAt has come', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(20), zone: 'UTC' } });
      assert.equal(stopsNow(log.state(), batch('b12'), at(19)), false);
      assert.equal(stopsNow(log.state(), batch('b12'), at(20)), true);
      order(13);
      accept({ kind: 'pause', order: { issue: 13 }, ...who });
      assert.equal(stopsNow(log.state(), batch('b13'), at(10_000)), false);
    });
  });

  describe('an order paused with --by under a pause of all', () => {
    it('stops at the earlier of the two stopAts, and shows that one', () => {
      order(12);
      order(13);
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(20), zone: 'UTC' } });
      accept({ kind: 'pause', ...who, stopAt: { at: at(60), zone: 'UTC' } });
      assert.equal(stopsNow(log.state(), batch('b12'), at(20)), true);
      assert.equal(stopsNow(log.state(), batch('b13'), at(20)), false);
      assert.deepStrictEqual(pauseOf(log.state(), batch('b12'))?.stopAt, {
        at: at(20).toISOString(),
        zone: 'UTC',
      });
    });

    it('keeps the order its own --by when the pause of all has none', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(20), zone: 'UTC' } });
      accept({ kind: 'pause', by: 'grace', via: 'plugin', why: 'release day' });
      assert.equal(stopsNow(log.state(), batch('b12'), at(20)), true);
      assert.deepStrictEqual(pauseOf(log.state(), batch('b12')), {
        by: 'grace',
        via: 'plugin',
        why: 'release day',
        stopAt: { at: at(20).toISOString(), zone: 'UTC' },
      });
    });
  });

  describe('continue', () => {
    it("lifts an order's pause, recorded with who and from where", () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      const events = accept({ kind: 'continue', order: { issue: 12 }, by: 'grace', via: 'plugin' });
      assert.deepStrictEqual(events[0], {
        type: 'order.continued',
        order: { issue: 12 },
        by: 'grace',
        via: 'plugin',
      });
      assert.equal(pauseOf(log.state(), batch('b12')), undefined);
    });

    it('is refused for an order that is not paused', () => {
      order(12);
      refuse({ kind: 'continue', order: { issue: 12 }, ...who }, /#12 is not paused/);
      refuse({ kind: 'continue', ...who }, /nothing is paused/);
    });

    it('is refused for one order while --all holds the Brewery', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'pause', ...who });
      refuse({ kind: 'continue', order: { issue: 12 }, ...who }, /continue --all/);
    });

    it("lifts --all and every order's pause with --all", () => {
      order(12);
      order(13);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'pause', ...who });
      accept({ kind: 'continue', ...who });
      assert.equal(pauseOf(log.state(), batch('b12')), undefined);
      assert.equal(pauseOf(log.state(), batch('b13')), undefined);
    });

    it('gives each scheduled attempt that has not started a new deadline from its step, in the store too', () => {
      order(12);
      order(13);
      start('b13');
      accept({ kind: 'pause', ...who });
      now = at(3 * 60);
      const events = accept({ kind: 'continue', ...who });
      const deadlineAt = new Date(now.getTime() + hour).toISOString();
      assert.deepStrictEqual(events.slice(1), [
        { type: 'step.rescheduled', batchId: 'b12', stepId: 'plan', attempt: 1, deadlineAt },
      ]);
      assert.equal(deadlineOf('b12', 'plan', 1), deadlineAt);
      // The started one keeps its deadline, which passed: the supervisor sees it due, b12 not.
      assert.deepStrictEqual(
        store.batchesPastDeadline(now).map(({ batchId }) => batchId),
        ['b13'],
      );
    });

    it('reschedules no attempt that Stuck abandoned, which a skip left behind', () => {
      order(12);
      // plan#1 never started: past its deadline the batch is Stuck, and the skip goes on to implement.
      now = at(2 * 60);
      accept({ kind: 'expire', batchId: 'b12', stepId: 'plan', attempt: 1 });
      accept({ kind: 'skip', batchId: 'b12', ...who });
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      const events = accept({ kind: 'continue', order: { issue: 12 }, ...who });
      assert.deepStrictEqual(
        events.map((event) => ('stepId' in event ? `${event.type} ${event.stepId}` : event.type)),
        ['order.continued', 'step.rescheduled implement'],
      );
    });

    it('reschedules only the batches whose pause it lifts', () => {
      order(12);
      order(13);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'pause', order: { issue: 13 }, ...who });
      const events = accept({ kind: 'continue', order: { issue: 12 }, ...who });
      assert.deepStrictEqual(
        events.map((event) => ('batchId' in event ? event.batchId : event.type)),
        ['order.continued', 'b12'],
      );
    });
  });

  describe('the intake under --all', () => {
    it("refuses the engine's order while --all holds, and not while only an order is paused", () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'order', batchId: 'b13', order: { issue: 13 } });
      accept({ kind: 'pause', ...who });
      refuse({ kind: 'order', batchId: 'b14', order: { issue: 14 } }, /paused/);
      accept({ kind: 'continue', ...who });
      accept({ kind: 'order', batchId: 'b14', order: { issue: 14 } });
    });

    it('still routes an Ordered batch while --all holds: routing starts nothing', () => {
      accept({ kind: 'order', batchId: 'b12', order: { issue: 12 } });
      accept({ kind: 'pause', ...who });
      accept({ kind: 'route', batchId: 'b12', recipe: 'pint', reason: 'label', source: 'label' });
      assert.equal(batch('b12').lane.kind, 'brewing');
    });
  });

  describe('a running attempt', () => {
    it('ends as it ends while paused, and what it schedules next waits', () => {
      order(12);
      start('b12');
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: succeeded });
      const next = batch('b12').steps.get('implement')?.attempts.get(1);
      assert.equal(next?.phase, 'scheduled');
    });

    it('stopped at the stopAt on its last allowed attempt is scheduled again, and counts against no retry', () => {
      order(12);
      start('b12');
      accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        ending: { kind: 'cancelled' },
      });
      start('b12', 'plan', 2);
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(10), zone: 'UTC' } });
      now = at(10);
      const stopped = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 2,
        ending: { kind: 'cancelled' },
        paused: true,
      });
      assert.deepStrictEqual(
        stopped.map((event) => event.type),
        ['step.finished', 'step.scheduled'],
      );
      assert.equal(batch('b12').lane.kind, 'brewing');
      accept({ kind: 'continue', order: { issue: 12 }, ...who });
      // Attempt 3 stands in for attempt 2: once it fails too, the step has used its attempts.
      start('b12', 'plan', 3);
      const failed = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 3,
        ending: { kind: 'cancelled' },
      });
      assert.deepStrictEqual(
        failed.map((event) => event.type),
        ['step.finished', 'batch.stuck'],
      );
    });

    it('is recorded as an ordinary cancelled end when its pause no longer stops it as the end comes', () => {
      order(12);
      start('b12');
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(10), zone: 'UTC' } });
      now = at(10);
      // The driver stopped the run; a person continued before its end was recorded.
      accept({ kind: 'continue', order: { issue: 12 }, ...who });
      const events = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        ending: { kind: 'cancelled' },
        paused: true,
      });
      assert.deepStrictEqual(events[0], {
        type: 'step.finished',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        outcome: { kind: 'cancelled' },
      });
      assert.equal(events[1]?.type, 'step.scheduled');
    });

    it('keeps what the stopped attempt took and the house-yeast rules it was given', () => {
      order(12);
      start('b12');
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(10), zone: 'UTC' } });
      now = at(10);
      const usage = { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 };
      const houseYeast = { selected: ['one-rule'], cut: [] };
      const [finished] = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        ending: { kind: 'cancelled' },
        paused: true,
        usage,
        houseYeast,
      });
      assert.deepStrictEqual(finished, {
        type: 'step.finished',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        outcome: { kind: 'cancelled' },
        usage,
        houseYeast,
        paused: true,
      });
    });

    it('leaves the attempt it stopped out of the count, so the next failure is retried', () => {
      order(12);
      start('b12');
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(10), zone: 'UTC' } });
      now = at(10);
      const plan = { batchId: 'b12', stepId: 'plan' } as const;
      accept({ kind: 'finish', ...plan, attempt: 1, ending: { kind: 'cancelled' }, paused: true });
      accept({ kind: 'continue', order: { issue: 12 }, ...who });
      start('b12', 'plan', 2);
      // Two attempts of two allowed, but the first was the pause's: attempt 3 is a retry.
      const retried = accept({
        kind: 'finish',
        ...plan,
        attempt: 2,
        ending: { kind: 'cancelled' },
      });
      assert.deepStrictEqual(
        retried.map((event) => `${event.type} ${'attempt' in event ? event.attempt : ''}`),
        ['step.finished 2', 'step.scheduled 3'],
      );
      start('b12', 'plan', 3);
      const exhausted = accept({
        kind: 'finish',
        ...plan,
        attempt: 3,
        ending: { kind: 'cancelled' },
      });
      const stuck = exhausted.at(-1);
      assert.equal(stuck?.type, 'batch.stuck');
      assert.deepStrictEqual(stuck?.type === 'batch.stuck' && stuck.reason, {
        kind: 'attempts_exhausted',
        stepId: 'plan',
        attempts: 2,
        lastReason: 'the attempt was cancelled',
      });
    });

    it('is refused as stopped by a pause when it did not end cancelled, even after the stopAt', () => {
      order(12);
      start('b12');
      accept({ kind: 'pause', order: { issue: 12 }, ...who, stopAt: { at: at(10), zone: 'UTC' } });
      now = at(10);
      refuse(
        {
          kind: 'finish',
          batchId: 'b12',
          stepId: 'plan',
          attempt: 1,
          ending: succeeded,
          paused: true,
        },
        /not stopped by a pause/,
      );
    });

    it('is not expired by the engine while its batch is paused, though its deadline passed', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      now = at(2 * 60);
      refuse(
        { kind: 'expire', batchId: 'b12', stepId: 'plan', attempt: 1 },
        /waits for its batch's pause/,
      );
      accept({ kind: 'continue', order: { issue: 12 }, ...who });
      // Its new deadline runs from the continue.
      refuse({ kind: 'expire', batchId: 'b12', stepId: 'plan', attempt: 1 }, /is not due until/);
    });

    it('keeps the deadline of a waiting step its recipe file dropped: the recipe gives it no other', () => {
      order(12);
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      // The recipe file changed under the batch: plan is no step of pint any more.
      const changed = createCommandLog({
        store,
        recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['implement'] }) }),
      });
      const decision = changed.issue({ kind: 'continue', order: { issue: 12 }, ...who }, now);
      assert.equal(decision.kind, 'accepted');
      assert.deepStrictEqual(
        decision.kind === 'accepted' && decision.events.map((event) => event.type),
        ['order.continued'],
      );
    });
  });

  describe('a parallel group', () => {
    it('lets each running child end at its own point, and its scheduled children wait', () => {
      order(12, 'tasting');
      start('b12');
      accept({ kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: succeeded });
      start('b12', 'a');
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      accept({ kind: 'finish', batchId: 'b12', stepId: 'a', attempt: 1, ending: succeeded });
      // The group waits for b, which never started.
      assert.equal(batch('b12').steps.get('b')?.attempts.get(1)?.phase, 'scheduled');
      assert.equal(batch('b12').steps.has('open'), false);
      now = at(5 * 60);
      const events = accept({ kind: 'continue', order: { issue: 12 }, ...who });
      assert.deepStrictEqual(
        events.slice(1).map((event) => ('stepId' in event ? event.stepId : '')),
        ['b'],
      );
    });
  });

  describe('the supervisor', () => {
    it('expires no scheduled attempt of a paused batch that has not started, and still a started one', () => {
      order(12);
      order(13);
      start('b13');
      accept({ kind: 'pause', ...who });
      now = at(2 * 60);
      const plan = planTick({
        state: log.state(),
        due: store.batchesPastDeadline(now),
        expiredLeases: [],
        progress: { progress: () => undefined },
        recipes,
        now,
      });
      assert.deepStrictEqual(
        plan.commands.map((command) => `${command.kind} ${command.batchId}`),
        ['expire b13'],
      );
    });
  });
});

describe('stopAtText (ADR 0202)', () => {
  it('shows the stop in UTC with the time and day in its zone', () => {
    assert.equal(
      stopAtText({ at: '2026-11-02T16:30:00.000Z', zone: 'Europe/Brussels' }),
      '16:30 UTC (17:30 Europe/Brussels, 2 November)',
    );
  });

  it('shows the stop in UTC with the zone named when this machine does not know the zone', () => {
    assert.equal(
      stopAtText({ at: '2026-11-02T16:30:00.000Z', zone: 'Nowhere/Atlantis' }),
      '16:30 UTC (Nowhere/Atlantis)',
    );
  });
});
