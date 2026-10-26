// The usage window (ADR 0206): an attempt that ends as claude hit a usage limit closes it and
// spends no retry; while it is closed no unstarted attempt expires, and at its reopen the engine
// opens it by itself and gives every held attempt a fresh deadline.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatStatus } from '../../src/cli/status.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command, Ending } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { emptyState } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { planTick } from '../../src/engine/supervisor.ts';
import { familyOf, reopenOf, usageWindowText } from '../../src/engine/usage-window.ts';
import type { UsageLimitName } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-10-26T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const recipes = fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 2 }) });
const who = { by: 'ada', via: 'terminal' } as const;
const limited: Ending = {
  kind: 'blocked',
  blockerKind: 'environment',
  summary: 'claude hit its session limit, which resets 3:45pm',
  usageLimit: { limit: 'session', resets: '3:45pm' },
};

describe('the usage window (ADR 0206)', () => {
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
  const order = (n: number): string => {
    const batchId = `b${n}`;
    accept({ kind: 'order', batchId, order: { issue: n } });
    accept({ kind: 'route', batchId, recipe: 'pint', reason: 'label', source: 'label' });
    return batchId;
  };
  const batch = (batchId: string): Batch => {
    const found = log.state().batches.get(batchId);
    assert.ok(found, `batch ${batchId}`);
    return found;
  };
  const start = (batchId: string, stepId = 'plan', attempt = 1) =>
    accept({ kind: 'record', event: { type: 'step.started', batchId, stepId, attempt } });
  /** Ends `batchId`'s attempt with a usage limit whose window reopens at `reopen`. */
  const hit = (batchId: string, attempt = 1, reopen = at(230), stepId = 'plan') =>
    accept({
      kind: 'finish',
      batchId,
      stepId,
      attempt,
      ending: limited,
      reopensAt: { at: reopen, read: true },
    });
  const types = (events: readonly { type: string }[]) => events.map((event) => event.type);

  describe('an attempt that hit a usage limit', () => {
    it('closes the window with the limit, the reset and its reopen, and is scheduled again', () => {
      order(12);
      start('b12');
      const events = hit('b12');
      assert.deepStrictEqual(events, [
        {
          type: 'step.finished',
          batchId: 'b12',
          stepId: 'plan',
          attempt: 1,
          outcome: {
            kind: 'failed',
            retryable: false,
            reason: 'blocked (environment): claude hit its session limit, which resets 3:45pm',
          },
          usageLimited: true,
        },
        {
          type: 'usage.window_closed',
          limit: 'session',
          resets: '3:45pm',
          reopensAt: at(230).toISOString(),
          read: true,
        },
        {
          type: 'step.scheduled',
          batchId: 'b12',
          stepId: 'plan',
          attempt: 2,
          deadlineAt: new Date(now.getTime() + hour).toISOString(),
          retry: true,
        },
      ]);
      assert.equal(batch('b12').lane.kind, 'brewing');
      assert.deepStrictEqual(log.state().usageWindows.all, {
        limit: 'session',
        resets: '3:45pm',
        reopensAt: at(230).toISOString(),
        read: true,
      });
    });

    it('spends no retry, also on its step last allowed attempt', () => {
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
      assert.deepStrictEqual(types(hit('b12', 2)), [
        'step.finished',
        'usage.window_closed',
        'step.scheduled',
      ]);
      assert.equal(batch('b12').lane.kind, 'brewing');
      // Attempt 3 stands in for attempt 2: once it fails too, the step has used its attempts.
      now = at(240);
      accept({ kind: 'reopen' });
      start('b12', 'plan', 3);
      const failed = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 3,
        ending: { kind: 'cancelled' },
      });
      assert.deepStrictEqual(types(failed), ['step.finished', 'batch.stuck']);
    });

    it('is left out of the count, so a later failure of its step is still retried', () => {
      order(12);
      start('b12');
      hit('b12', 1, at(230));
      now = at(240);
      accept({ kind: 'reopen' });
      start('b12', 'plan', 2);
      const plan = { batchId: 'b12', stepId: 'plan' } as const;
      const retried = accept({
        kind: 'finish',
        ...plan,
        attempt: 2,
        ending: { kind: 'cancelled' },
      });
      assert.deepStrictEqual(types(retried), ['step.finished', 'step.scheduled']);
      start('b12', 'plan', 3);
      const stuck = accept({ kind: 'finish', ...plan, attempt: 3, ending: { kind: 'cancelled' } });
      const last = stuck.at(-1);
      assert.deepStrictEqual(last?.type === 'batch.stuck' && last.reason, {
        kind: 'attempts_exhausted',
        stepId: 'plan',
        attempts: 2,
        lastReason: 'the attempt was cancelled',
      });
    });

    it('is refused without the reopen the driver read', () => {
      order(12);
      start('b12');
      refuse(
        { kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: limited },
        /usage limit.*reopen/,
      );
    });

    it('closes the window also when its step left the recipe, which makes the batch Stuck', () => {
      order(12);
      start('b12');
      // The recipe file changed under the batch: plan is no step of pint any more.
      const changed = createCommandLog({
        store,
        recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['implement'] }) }),
      });
      const decision = changed.issue(
        {
          kind: 'finish',
          batchId: 'b12',
          stepId: 'plan',
          attempt: 1,
          ending: limited,
          reopensAt: { at: at(230), read: true },
        },
        now,
      );
      assert.deepStrictEqual(decision.kind === 'accepted' && types(decision.events), [
        'step.finished',
        'usage.window_closed',
        'batch.stuck',
      ]);
    });

    it('is refused when its end is not blocked on the environment', () => {
      order(12);
      start('b12');
      refuse(
        {
          kind: 'finish',
          batchId: 'b12',
          stepId: 'plan',
          attempt: 1,
          ending: { ...limited, blockerKind: 'divergence' },
          reopensAt: { at: at(230), read: true },
        },
        /not blocked on the environment/,
      );
    });

    // Review of #543: the runner cuts claude's text to 200 characters and an ellipsis.
    it('takes a reset as long as the runner cuts it', () => {
      order(12);
      start('b12');
      const resets = `${'x'.repeat(200)}…`;
      const events = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        ending: { ...limited, usageLimit: { limit: 'session', resets } },
        reopensAt: { at: at(60), read: false },
      });
      assert.deepStrictEqual(types(events), [
        'step.finished',
        'usage.window_closed',
        'step.scheduled',
      ]);
    });

    it('is kept by a new command log on the same store, as after a restart', () => {
      order(12);
      start('b12');
      hit('b12');
      const restarted = createCommandLog({ store, recipes });
      assert.equal(restarted.state().usageWindows.all?.reopensAt, at(230).toISOString());
    });
  });

  describe('a spend limit', () => {
    it('still makes the batch Stuck, blocked on the environment (ADR 0129)', () => {
      order(12);
      start('b12');
      const events = accept({
        kind: 'finish',
        batchId: 'b12',
        stepId: 'plan',
        attempt: 1,
        ending: {
          kind: 'blocked',
          blockerKind: 'environment',
          summary: 'claude hit its monthly spend limit',
        },
      });
      assert.deepStrictEqual(types(events), ['step.finished', 'batch.stuck']);
      assert.deepStrictEqual(log.state().usageWindows, {});
    });
  });

  describe('a second limit', () => {
    it('while closed keeps the later reopen', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hit('b12', 1, at(230));
      // An earlier reset moves nothing.
      assert.deepStrictEqual(types(hit('b13', 1, at(200))), ['step.finished', 'step.scheduled']);
      assert.equal(log.state().usageWindows.all?.reopensAt, at(230).toISOString());
      start('b12', 'plan', 2);
      // A later one moves the reopen.
      assert.deepStrictEqual(types(hit('b12', 2, at(300))), [
        'step.finished',
        'usage.window_closed',
        'step.scheduled',
      ]);
      assert.equal(log.state().usageWindows.all?.reopensAt, at(300).toISOString());
    });

    it('while closed with the same reopen records no second close', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hit('b12', 1, at(230));
      assert.deepStrictEqual(types(hit('b13', 1, at(230))), ['step.finished', 'step.scheduled']);
    });

    it('after the reopen closes the window again', () => {
      order(12);
      start('b12');
      hit('b12', 1, at(30));
      now = at(30);
      accept({ kind: 'reopen' });
      assert.deepStrictEqual(log.state().usageWindows, {});
      start('b12', 'plan', 2);
      hit('b12', 2, at(120));
      assert.equal(log.state().usageWindows.all?.reopensAt, at(120).toISOString());
    });
  });

  describe('while the window is closed', () => {
    it('no attempt that has not started expires, though its deadline passed; a started one does', () => {
      order(12);
      order(13);
      start('b12');
      hit('b12', 1, at(5 * 60));
      start('b13');
      now = at(2 * 60);
      refuse(
        { kind: 'expire', batchId: 'b12', stepId: 'plan', attempt: 2 },
        /waits for the usage window/,
      );
      const events = accept({ kind: 'expire', batchId: 'b13', stepId: 'plan', attempt: 1 });
      assert.equal(events.at(-1)?.type, 'batch.stuck');
    });

    it('the supervisor expires no attempt that has not started, and asks for no reopen before it', () => {
      order(12);
      order(13);
      start('b12');
      hit('b12', 1, at(5 * 60));
      start('b13');
      now = at(2 * 60);
      const plan = planTick({
        state: log.state(),
        due: store.batchesPastDeadline(now),
        expiredLeases: [],
        progress: { progress: () => undefined },
        recipes,
        now,
      });
      // b12's plan#2 waits past its deadline.
      assert.equal(batch('b12').lane.kind, 'brewing');
      assert.deepStrictEqual(
        plan.commands.map((command) => `${command.kind} ${command.batchId}`),
        ['expire b13'],
      );
      assert.equal(plan.reopen, undefined);
    });
  });

  describe('the reopen', () => {
    it('is asked for by the supervisor once its instant has come', () => {
      order(12);
      start('b12');
      hit('b12', 1, at(230));
      now = at(230);
      const plan = planTick({
        state: log.state(),
        due: [],
        expiredLeases: [],
        progress: { progress: () => undefined },
        recipes,
        now,
      });
      assert.equal(plan.reopen, true);
    });

    it('is refused before its instant, and when the window is open', () => {
      refuse({ kind: 'reopen' }, /usage window is open/);
      order(12);
      start('b12');
      hit('b12', 1, at(230));
      now = at(229);
      refuse({ kind: 'reopen' }, /reopens at/);
    });

    it('opens the window and gives each held attempt a fresh deadline, in the store too', () => {
      order(12);
      order(13);
      start('b12');
      hit('b12', 1, at(230));
      now = at(230);
      const events = accept({ kind: 'reopen' });
      const deadlineAt = new Date(now.getTime() + hour).toISOString();
      assert.deepStrictEqual(events, [
        { type: 'usage.window_opened', at: now.toISOString(), scope: 'all' },
        { type: 'step.rescheduled', batchId: 'b12', stepId: 'plan', attempt: 2, deadlineAt },
        { type: 'step.rescheduled', batchId: 'b13', stepId: 'plan', attempt: 1, deadlineAt },
      ]);
      assert.deepStrictEqual(log.state().usageWindows, {});
      assert.deepStrictEqual(store.batchesPastDeadline(now), []);
    });

    it('leaves a paused batch to its continue, which then gives it its deadline', () => {
      order(12);
      start('b12');
      hit('b12', 1, at(230));
      accept({ kind: 'pause', order: { issue: 12 }, ...who });
      now = at(230);
      assert.deepStrictEqual(types(accept({ kind: 'reopen' })), ['usage.window_opened']);
      now = at(300);
      assert.deepStrictEqual(types(accept({ kind: 'continue', order: { issue: 12 }, ...who })), [
        'order.continued',
        'step.rescheduled',
      ]);
    });

    it('leaves a stopped batch Stuck (ADR 0205)', () => {
      order(12);
      start('b12');
      hit('b12', 1, at(230));
      accept({ kind: 'stop', order: { issue: 12 }, ...who });
      now = at(230);
      assert.deepStrictEqual(types(accept({ kind: 'reopen' })), ['usage.window_opened']);
      assert.equal(batch('b12').lane.kind, 'stuck');
    });
  });

  describe('a window per scope (ADR 0215)', () => {
    /** Ends `batchId`'s attempt with claude's `limit`, whose window reopens at `reopen`. */
    const hitBy = (batchId: string, limit: UsageLimitName, reopen: Date, attempt = 1) =>
      accept({
        kind: 'finish',
        batchId,
        stepId: 'plan',
        attempt,
        ending: { ...limited, usageLimit: { limit, resets: '3:45pm' } },
        reopensAt: { at: reopen, read: true },
      });
    const window = (limit: UsageLimitName, reopen: Date) => ({
      limit,
      resets: '3:45pm',
      reopensAt: reopen.toISOString(),
      read: true,
    });
    const tick = () =>
      planTick({
        state: log.state(),
        due: store.batchesPastDeadline(now),
        expiredLeases: [],
        progress: { progress: () => undefined },
        recipes,
        now,
      });

    it('closes only the Opus window for an Opus limit, only the Sonnet one for a Sonnet limit', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hitBy('b12', 'Opus', at(230));
      assert.deepStrictEqual(log.state().usageWindows, { Opus: window('Opus', at(230)) });
      hitBy('b13', 'Sonnet', at(100));
      assert.deepStrictEqual(log.state().usageWindows, {
        Opus: window('Opus', at(230)),
        Sonnet: window('Sonnet', at(100)),
      });
    });

    it('closes the window of every brewer for a session or weekly limit, beside a closed family', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hitBy('b12', 'Opus', at(230));
      hitBy('b13', 'weekly', at(300));
      assert.deepStrictEqual(log.state().usageWindows, {
        Opus: window('Opus', at(230)),
        all: window('weekly', at(300)),
      });
    });

    it('keeps the later reopen within a scope, whatever another scope reopens at', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hitBy('b12', 'Opus', at(230));
      // An earlier Opus reset moves nothing, though no Sonnet or session window is closed.
      assert.deepStrictEqual(types(hitBy('b13', 'Opus', at(200))), [
        'step.finished',
        'step.scheduled',
      ]);
      start('b13', 'plan', 2);
      // A Sonnet limit closes its own window, though its reopen is earlier than Opus's.
      assert.deepStrictEqual(types(hitBy('b13', 'Sonnet', at(100), 2)), [
        'step.finished',
        'usage.window_closed',
        'step.scheduled',
      ]);
    });

    it('reopens each scope at its own reset, the other staying closed, and reschedules at each', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hitBy('b12', 'Opus', at(230));
      hitBy('b13', 'weekly', at(300));
      now = at(229);
      refuse({ kind: 'reopen' }, /reopens at/);
      assert.equal(tick().reopen, undefined);
      now = at(230);
      assert.equal(tick().reopen, true);
      const deadlineAt = (minutes: number) => new Date(at(minutes).getTime() + hour).toISOString();
      assert.deepStrictEqual(accept({ kind: 'reopen' }), [
        { type: 'usage.window_opened', at: at(230).toISOString(), scope: 'Opus' },
        {
          type: 'step.rescheduled',
          batchId: 'b12',
          stepId: 'plan',
          attempt: 2,
          deadlineAt: deadlineAt(230),
        },
        {
          type: 'step.rescheduled',
          batchId: 'b13',
          stepId: 'plan',
          attempt: 2,
          deadlineAt: deadlineAt(230),
        },
      ]);
      assert.deepStrictEqual(log.state().usageWindows, { all: window('weekly', at(300)) });
      // Held still by the window of every brewer: no expire, and no second reopen until its own.
      now = at(299);
      assert.deepStrictEqual(tick(), { commands: [], releaseLeases: [] });
      now = at(300);
      assert.deepStrictEqual(types(accept({ kind: 'reopen' })), [
        'usage.window_opened',
        'step.rescheduled',
        'step.rescheduled',
      ]);
      assert.deepStrictEqual(log.state().usageWindows, {});
    });

    it('opens every window whose reopen has come in one reopen', () => {
      order(12);
      order(13);
      start('b12');
      start('b13');
      hitBy('b12', 'Opus', at(230));
      hitBy('b13', 'Sonnet', at(200));
      now = at(240);
      const events = accept({ kind: 'reopen' });
      assert.deepStrictEqual(
        events.flatMap((event) => (event.type === 'usage.window_opened' ? [event.scope] : [])),
        ['Opus', 'Sonnet'],
      );
      assert.deepStrictEqual(log.state().usageWindows, {});
    });

    it('reopens a window a log of #543 closed, by the scope its limit names', () => {
      order(12);
      store.withTransaction((tx) =>
        tx.append({
          type: 'usage.window_closed',
          limit: 'Sonnet',
          resets: '3:45pm',
          reopensAt: at(230).toISOString(),
          read: true,
        }),
      );
      const restarted = createCommandLog({ store, recipes });
      assert.deepStrictEqual(restarted.state().usageWindows, { Sonnet: window('Sonnet', at(230)) });
      now = at(230);
      const decision = restarted.issue({ kind: 'reopen' }, now);
      assert.deepStrictEqual(decision.kind === 'accepted' && decision.events[0], {
        type: 'usage.window_opened',
        at: at(230).toISOString(),
        scope: 'Sonnet',
      });
    });
  });
});

describe('reopenOf (ADR 0206)', () => {
  const zone = 'Europe/Brussels';
  // 2026-10-26 is a Monday; Brussels is on UTC+1 from 25 October, UTC+2 before.
  const read = (resets: string, now: string, in_ = zone) => {
    const { at: reopen, read: wasRead } = reopenOf(resets, new Date(now), in_);
    return { at: reopen.toISOString(), read: wasRead };
  };

  it('reads 3:45pm as today at 15:45 there, plus 5 minutes, before then', () => {
    assert.deepStrictEqual(read('3:45pm', '2026-10-26T09:00:00.000Z'), {
      at: '2026-10-26T14:50:00.000Z',
      read: true,
    });
  });

  it('reads 3:45pm as tomorrow at 15:45 there, plus 5 minutes, once it passed over an hour ago', () => {
    // 16:46 there.
    assert.deepStrictEqual(read('3:45pm', '2026-10-26T15:46:00.000Z'), {
      at: '2026-10-27T14:50:00.000Z',
      read: true,
    });
  });

  // Review of #543: the end may be handled minutes after claude wrote it, or claude may round the
  // reset to the minute; a day's hold would be wrong, and no person could lift it.
  it('reads 3:45pm as today when it passed within the hour, so the window reopens after the margin', () => {
    // 15:47 and 16:45 there.
    for (const now of ['2026-10-26T14:47:00.000Z', '2026-10-26T15:45:00.000Z']) {
      assert.deepStrictEqual(read('3:45pm', now), { at: '2026-10-26T14:50:00.000Z', read: true });
    }
  });

  // Review of #543: the hour before may be yesterday's, or last week's weekday.
  it('reads 11:58pm read just after midnight as yesterday, not tonight', () => {
    // 00:02 on Monday 26 October there.
    assert.deepStrictEqual(read('11:58pm', '2026-10-25T23:02:00.000Z'), {
      at: '2026-10-25T23:03:00.000Z',
      read: true,
    });
  });

  it('reads Sun 11:30pm read on Monday at 00:10 as the Sunday just gone, not next Sunday', () => {
    assert.equal(read('Sun 11:30pm', '2026-10-25T23:10:00.000Z').at, '2026-10-25T22:35:00.000Z');
  });

  it('reads Mon 12:00am as this Monday when it passed within the hour, not next week', () => {
    // 00:10 on Monday 26 October there.
    assert.equal(read('Mon 12:00am', '2026-10-25T23:10:00.000Z').at, '2026-10-25T23:05:00.000Z');
  });

  it('keeps the wall-clock time across a change of clocks', () => {
    // 20:00 on Saturday in summer time; 15:45 on Sunday is in winter time.
    assert.deepStrictEqual(read('3:45pm', '2026-10-24T18:00:00.000Z'), {
      at: '2026-10-25T14:50:00.000Z',
      read: true,
    });
  });

  it('reads 12am as midnight and 12pm as noon', () => {
    assert.equal(read('12:30am', '2026-10-26T09:00:00.000Z').at, '2026-10-26T23:35:00.000Z');
    assert.equal(read('12:00pm', '2026-10-26T09:00:00.000Z').at, '2026-10-26T11:05:00.000Z');
  });

  it('reads Mon 12:00am as the coming Monday at midnight, from another day, across the change', () => {
    // Saturday 24 October, summer time: Monday 26 at 00:00 is in winter time.
    assert.deepStrictEqual(read('Mon 12:00am', '2026-10-24T09:00:00.000Z'), {
      at: '2026-10-25T23:05:00.000Z',
      read: true,
    });
    // Wednesday 28 October.
    assert.equal(read('Mon 12:00am', '2026-10-28T09:00:00.000Z').at, '2026-11-01T23:05:00.000Z');
  });

  it('reads Mon 12:00am on a Monday after midnight as the Monday after', () => {
    assert.equal(read('Mon 12:00am', '2026-10-26T09:00:00.000Z').at, '2026-11-01T23:05:00.000Z');
  });

  it('reads every weekday by its own name', () => {
    // From Monday 26 October.
    assert.equal(read('Wed 9:00am', '2026-10-26T09:00:00.000Z').at, '2026-10-28T08:05:00.000Z');
    assert.equal(read('Sun 11:30pm', '2026-10-26T09:00:00.000Z').at, '2026-11-01T22:35:00.000Z');
    assert.equal(read('Tue 1:00am', '2026-10-26T09:00:00.000Z').at, '2026-10-27T00:05:00.000Z');
    assert.equal(read('Thu 1:00am', '2026-10-26T09:00:00.000Z').at, '2026-10-29T00:05:00.000Z');
    assert.equal(read('Fri 1:00am', '2026-10-26T09:00:00.000Z').at, '2026-10-30T00:05:00.000Z');
    assert.equal(read('Sat 1:00am', '2026-10-26T09:00:00.000Z').at, '2026-10-31T00:05:00.000Z');
  });

  it('reads a weekday later on the same day as today', () => {
    assert.equal(read('Mon 3:45pm', '2026-10-26T09:00:00.000Z').at, '2026-10-26T14:50:00.000Z');
  });

  it('tries again in an hour when it cannot read the reset', () => {
    for (const resets of [
      'soon',
      '15:45',
      '3:45 pm',
      '13:00pm',
      '3:60pm',
      'Monday 12:00am',
      '3pm',
      '3:45pm (Europe/Paris)',
      '3:45pmx',
      '3:45PM',
      '0:30am',
      '3:5pm',
      'mon 12:00am',
    ]) {
      assert.deepStrictEqual(
        read(resets, '2026-10-26T09:00:00.000Z'),
        { at: '2026-10-26T10:00:00.000Z', read: false },
        resets,
      );
    }
  });

  it('tries again in an hour when this machine reports a zone it cannot read a time in', () => {
    assert.deepStrictEqual(read('3:45pm', '2026-10-26T09:00:00.000Z', 'Etc/Unknown'), {
      at: '2026-10-26T10:00:00.000Z',
      read: false,
    });
  });
});

describe('usageWindowText (ADR 0206)', () => {
  const window = {
    limit: 'session',
    resets: '3:45pm',
    reopensAt: '2026-10-26T14:50:00.000Z',
    read: true,
  } as const;

  it('names the limit, the reset as claude wrote it, and when brewers start again in UTC', () => {
    assert.equal(
      usageWindowText(window),
      'Usage window closed: claude hit its session limit, which resets 3:45pm; brewers wait until 14:50 UTC, 26 October',
    );
    assert.equal(
      usageWindowText({ ...window, read: false }),
      'Usage window closed: claude hit its session limit, which resets 3:45pm; brewers try again at 14:50 UTC, 26 October',
    );
  });

  it("names a family's window and the brewers on it (ADR 0215)", () => {
    assert.equal(
      usageWindowText({ ...window, limit: 'Opus' }),
      'Opus usage window closed: claude hit its Opus limit, which resets 3:45pm; brewers on Opus wait until 14:50 UTC, 26 October',
    );
    assert.equal(
      usageWindowText({ ...window, limit: 'Sonnet', read: false }),
      'Sonnet usage window closed: claude hit its Sonnet limit, which resets 3:45pm; brewers on Sonnet try again at 14:50 UTC, 26 October',
    );
  });
});

describe('formatStatus with the usage window closed (ADR 0206)', () => {
  const session = {
    limit: 'session',
    resets: '3:45pm',
    reopensAt: '2026-10-26T14:50:00.000Z',
    read: true,
  } as const;

  it('shows the window above No batches. too', () => {
    assert.equal(
      formatStatus({ ...emptyState, usageWindows: { all: session } }),
      'Usage window closed: claude hit its session limit, which resets 3:45pm; brewers wait until 14:50 UTC, 26 October\n\nNo batches.\n',
    );
  });

  it('shows a line for each closed window, every brewer first, then Opus, then Sonnet (ADR 0215)', () => {
    const sonnet = { ...session, limit: 'Sonnet', reopensAt: '2026-10-26T16:50:00.000Z' } as const;
    const opus = { ...session, limit: 'Opus', resets: '5:45pm' } as const;
    assert.equal(
      formatStatus({ ...emptyState, usageWindows: { Sonnet: sonnet, Opus: opus } }),
      [
        'Opus usage window closed: claude hit its Opus limit, which resets 5:45pm; brewers on Opus wait until 14:50 UTC, 26 October',
        'Sonnet usage window closed: claude hit its Sonnet limit, which resets 3:45pm; brewers on Sonnet wait until 16:50 UTC, 26 October',
        '',
        'No batches.',
        '',
      ].join('\n'),
    );
    assert.match(
      formatStatus({ ...emptyState, usageWindows: { Opus: opus, all: session } }),
      /^Usage window closed: claude hit its session limit.*\nOpus usage window closed/,
    );
  });
});

describe('familyOf (ADR 0215)', () => {
  it('tells Opus and Sonnet by a word of the model id or family', () => {
    for (const model of ['claude-opus-5-5', 'opus', 'opus[1m]', 'claude-3-opus-20240229']) {
      assert.equal(familyOf(model), 'Opus', model);
    }
    for (const model of ['claude-sonnet-5-5', 'sonnet', 'sonnet[1m]', 'us.anthropic.sonnet-4']) {
      assert.equal(familyOf(model), 'Sonnet', model);
    }
  });

  it('cannot tell another family, a word that only holds the name, or a model with both', () => {
    for (const model of [
      'claude-haiku-5-5',
      'claude-fable-5-1',
      'default',
      'opusx',
      'sonnets-5',
      'opus-sonnet',
    ]) {
      assert.equal(familyOf(model), undefined, model);
    }
  });
});
