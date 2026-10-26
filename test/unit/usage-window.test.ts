// The usage window (ADR 0206): an attempt that ends as claude hit a usage limit closes it and
// spends no retry; while it is closed no unstarted attempt expires, and at its reopen the engine
// opens it by itself and gives every held attempt a fresh deadline.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command, Ending } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { planTick } from '../../src/engine/supervisor.ts';
import { reopenOf, usageWindowText } from '../../src/engine/usage-window.ts';
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
      assert.deepStrictEqual(log.state().usageWindow, {
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

    it('is refused without the reopen the driver read', () => {
      order(12);
      start('b12');
      refuse(
        { kind: 'finish', batchId: 'b12', stepId: 'plan', attempt: 1, ending: limited },
        /usage limit.*reopen/,
      );
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

    it('is kept by a new command log on the same store, as after a restart', () => {
      order(12);
      start('b12');
      hit('b12');
      const restarted = createCommandLog({ store, recipes });
      assert.equal(restarted.state().usageWindow?.reopensAt, at(230).toISOString());
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
      assert.equal(log.state().usageWindow?.reopensAt, at(230).toISOString());
      start('b12', 'plan', 2);
      // A later one moves the reopen.
      assert.deepStrictEqual(types(hit('b12', 2, at(300))), [
        'step.finished',
        'usage.window_closed',
        'step.scheduled',
      ]);
      assert.equal(log.state().usageWindow?.reopensAt, at(300).toISOString());
    });

    it('after the reopen closes the window again', () => {
      order(12);
      start('b12');
      hit('b12', 1, at(30));
      now = at(30);
      accept({ kind: 'reopen' });
      assert.equal(log.state().usageWindow, undefined);
      start('b12', 'plan', 2);
      hit('b12', 2, at(120));
      assert.equal(log.state().usageWindow?.reopensAt, at(120).toISOString());
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
        { type: 'usage.window_opened', at: now.toISOString() },
        { type: 'step.rescheduled', batchId: 'b12', stepId: 'plan', attempt: 2, deadlineAt },
        { type: 'step.rescheduled', batchId: 'b13', stepId: 'plan', attempt: 1, deadlineAt },
      ]);
      assert.equal(log.state().usageWindow, undefined);
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

  it('reads 3:45pm as tomorrow at 15:45 there, plus 5 minutes, once it has passed', () => {
    assert.deepStrictEqual(read('3:45pm', '2026-10-26T15:00:00.000Z'), {
      at: '2026-10-27T14:50:00.000Z',
      read: true,
    });
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
  it('names the limit, the reset as claude wrote it, and when brewers start again in UTC', () => {
    const window = {
      limit: 'Opus',
      resets: '3:45pm',
      reopensAt: '2026-10-26T14:50:00.000Z',
      read: true,
    } as const;
    assert.equal(
      usageWindowText(window),
      'Usage window closed: claude hit its Opus limit, which resets 3:45pm; brewers wait until 14:50 UTC, 26 October',
    );
    assert.equal(
      usageWindowText({ ...window, read: false }),
      'Usage window closed: claude hit its Opus limit, which resets 3:45pm; brewers try again at 14:50 UTC, 26 October',
    );
  });
});
