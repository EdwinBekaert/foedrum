import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { type Batch, fold, type State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { FlushResult } from '../../src/engine/state-branch-git.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import {
  createSupervisor,
  type Notice,
  type Supervisor,
  type SupervisorOptions,
  type Timer,
} from '../../src/engine/supervisor-loop.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const day = 24 * hour;
const t0 = new Date('2026-10-15T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const iso = (minutes: number): string => at(minutes).toISOString();
const pullRequest = 'https://github.com/acme/api/pull/7';

const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'], stall: { turns: 60 } }),
});

/** An Ordered batch, to be routed `routeBy` minutes from t0 (default a day). */
const ordered = (batchId: string, routeBy = 24 * 60): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue: Number(batchId.slice(1)) },
  routeBy: iso(routeBy),
});
const brewing = (batchId: string, deadline: number, recipe = 'pint'): Event[] => [
  ordered(batchId),
  { type: 'batch.recipe_chosen', batchId, recipe, reason: 'feature label', source: 'label' },
  { type: 'step.scheduled', batchId, stepId: 'plan', attempt: 1, deadlineAt: iso(deadline) },
  { type: 'step.started', batchId, stepId: 'plan', attempt: 1 },
];
const conditioning = (batchId: string, remindAt: number): Event[] => [
  ordered(batchId),
  { type: 'batch.waiting', batchId, on: { kind: 'merge', pullRequest }, remindAt: iso(remindAt) },
];
const stuck = (batchId: string, remindAt: number): Event[] => [
  ...brewing(batchId, 60),
  {
    type: 'batch.stuck',
    batchId,
    reason: { kind: 'waiting_for_session', stepId: 'plan' },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt: iso(remindAt),
  },
];
const plan = (batchId: string, attempt = 1): AttemptRef => ({ batchId, stepId: 'plan', attempt });

/** A timer whose callbacks run when the test fires them, awaiting the tick they run. */
const fakeTimer = () => {
  const pending = new Map<number, { fn: () => Promise<void>; ms: number }>();
  let next = 0;
  const timer: Timer = {
    set: (fn, ms) => {
      pending.set(++next, { fn, ms });
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  const fire = async (): Promise<void> => {
    const [entry] = pending;
    assert.ok(entry, 'a tick is scheduled');
    pending.delete(entry[0]);
    await entry[1].fn();
  };
  return { timer, pending, fire };
};

/** A state branch whose flushes return `results` in turn, then `unchanged`. */
const fakeBranch = (...results: (FlushResult | Error)[]) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    flush: async (): Promise<FlushResult> => {
      calls++;
      const result = results.shift() ?? { kind: 'unchanged' };
      if (result instanceof Error) throw result;
      return result;
    },
  };
};

const stateOf = (store: EventStore): State => fold(store.eventsAfter(0).map(({ event }) => event));
const batchOf = (store: EventStore, batchId: string): Batch => {
  const batch = stateOf(store).batches.get(batchId);
  assert.ok(batch, batchId);
  return batch;
};
const runningOf = (batch: Batch) =>
  [...batch.steps.values()].flatMap((step) => {
    const latest = step.attempts.get(Math.max(...step.attempts.keys()));
    return latest && latest.phase !== 'finished' && latest.abandoned !== true ? [latest] : [];
  });

/** Invariant I1: every non-terminal batch has exactly one pending action with a deadline ahead. */
const assertI1 = (store: EventStore, now: Date): void => {
  const pending = new Map(
    store.batchesPastDeadline(new Date(8.64e15)).map((due) => [due.batchId, due.deadlineAt]),
  );
  assert.deepStrictEqual(store.batchesPastDeadline(now), [], 'nothing is due after a tick');
  for (const batch of stateOf(store).batches.values()) {
    const { lane } = batch;
    const deadline = pending.get(batch.id)?.getTime();
    switch (lane.kind) {
      case 'brewing': {
        const running = runningOf(batch);
        assert.equal(running.length, 1, `${batch.id} runs one attempt`);
        assert.equal(deadline, Date.parse(running[0]?.deadlineAt ?? ''), batch.id);
        break;
      }
      case 'ordered':
        assert.equal(deadline, Date.parse(lane.routeBy), batch.id);
        break;
      case 'conditioning':
      case 'stuck':
        assert.equal(deadline, Date.parse(lane.remindAt), batch.id);
        break;
      case 'on_tap':
      case 'cancelled':
        break;
      default: {
        const unhandled: never = lane;
        throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
      }
    }
    if (deadline !== undefined) assert.ok(deadline > now.getTime(), `${batch.id} waits ahead`);
  }
};

describe('createSupervisor', () => {
  let store: EventStore;
  let now: Date;
  let notices: Notice[];
  let progress: Map<string, AttemptProgress>;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    notices = [];
    progress = new Map();
  });
  afterEach(() => store.close());

  const append = (...events: Event[]): void =>
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });
  const supervisor = (options: Partial<SupervisorOptions> = {}) =>
    createSupervisor({
      store,
      stateBranch: fakeBranch(),
      recipes,
      progress: { progress: (ref) => progress.get(attemptKey.encode(ref)) },
      clock: () => now,
      timer: fakeTimer().timer,
      report: (notice) => notices.push(notice),
      ...options,
    });

  describe('tick', () => {
    it('makes a batch Stuck once its attempt is past its deadline', async () => {
      append(...brewing('b1', 30));
      const engine = supervisor();
      now = at(29);
      assert.equal((await engine.tick()).appended, 0);
      assert.equal(batchOf(store, 'b1').lane.kind, 'brewing');

      now = at(30);
      assert.equal((await engine.tick()).appended, 1);
      assert.deepStrictEqual(batchOf(store, 'b1').lane, {
        kind: 'stuck',
        reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: iso(30) },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: new Date(at(30).getTime() + 2 * day).toISOString(),
      });
      assert.deepStrictEqual(notices, []);
    });

    it('makes an Ordered batch Stuck on routing within one tick of its routing deadline', async () => {
      append(ordered('b1', 30));
      const engine = supervisor();
      now = at(29);
      assert.equal((await engine.tick()).appended, 0);
      assert.equal(batchOf(store, 'b1').lane.kind, 'ordered');

      now = at(30);
      assert.equal((await engine.tick()).appended, 1);
      assert.deepStrictEqual(batchOf(store, 'b1').lane, {
        kind: 'stuck',
        reason: { kind: 'routing', deadlineAt: iso(30) },
        options: ['retry', 'recipe', 'cancel'],
        remindAt: new Date(at(30).getTime() + 2 * day).toISOString(),
      });
      assertI1(store, now);
      assert.deepStrictEqual(notices, []);
    });

    it('sets the next reminder of a Stuck batch, at the configured interval', async () => {
      append(...stuck('b1', 10));
      now = at(10);
      await supervisor({ reminderMs: 3 * hour }).tick();
      const { lane } = batchOf(store, 'b1');
      assert.equal(lane.kind === 'stuck' && lane.remindAt, iso(10 + 180));
    });

    it('reminds a Conditioning batch every 2 days by default', async () => {
      append(...conditioning('b1', 10));
      now = at(10);
      await supervisor().tick();
      const { lane } = batchOf(store, 'b1');
      assert.equal(
        lane.kind === 'conditioning' && lane.remindAt,
        new Date(at(10).getTime() + 2 * day).toISOString(),
      );
    });

    it('retries an attempt whose lease expired, and releases the lease', async () => {
      append(...brewing('b1', 60));
      store.withTransaction((tx) =>
        tx.putLease({
          attemptKey: attemptKey.encode(plan('b1')),
          owner: 'runner-1',
          expiresAt: at(5),
        }),
      );
      now = at(5);
      assert.equal((await supervisor().tick()).appended, 2);
      const step = batchOf(store, 'b1').steps.get('plan');
      assert.deepStrictEqual(step?.attempts.get(1), {
        phase: 'finished',
        attempt: 1,
        deadlineAt: iso(60),
        outcome: {
          kind: 'failed',
          retryable: true,
          reason: `the attempt was lost: the lease of runner-1 expired at ${iso(5)}`,
        },
      });
      assert.deepStrictEqual(step?.attempts.get(2), {
        phase: 'scheduled',
        attempt: 2,
        deadlineAt: iso(65),
      });
      assert.deepStrictEqual(store.expiredLeases(at(600)), []);
    });

    it('makes a batch Stuck when the runner reports a stall', async () => {
      append(...brewing('b1', 60));
      progress.set(attemptKey.encode(plan('b1')), {
        lastProgressAt: at(1),
        turnsWithoutProgress: 60,
      });
      now = at(2);
      await supervisor().tick();
      const { lane } = batchOf(store, 'b1');
      assert.deepStrictEqual(lane.kind === 'stuck' && lane.reason, {
        kind: 'stalled',
        stepId: 'plan',
        lastProgressAt: iso(1),
        turnsWithoutProgress: 60,
      });
    });

    it('sees the events others appended since the last tick', async () => {
      const engine = supervisor();
      await engine.tick();
      // Only a state that folded these events knows b1, so only it can make b1 Stuck.
      append(...brewing('b1', 30));
      now = at(45);
      assert.equal((await engine.tick()).appended, 1);
      assert.equal(batchOf(store, 'b1').lane.kind, 'stuck');
    });

    it('decides each command against the events another writer appended during the tick', async () => {
      append(...brewing('b1', 30), ...brewing('b2', 120));
      now = at(45);
      const engine = supervisor({
        // A terminal cancels b1 after the tick planned its expiry, before it is decided: while
        // the tick asks for b2's progress.
        progress: {
          progress: () => {
            append({ type: 'batch.cancelled', batchId: 'b1', by: 'ada', via: 'terminal' });
            return undefined;
          },
        },
      });
      assert.equal((await engine.tick()).appended, 0);
      assert.equal(stateOf(store).batches.get('b1')?.lane.kind, 'cancelled');
      assert.equal(store.eventsAfter(0).at(-1)?.event.type, 'batch.cancelled');
      assert.deepStrictEqual(
        notices.map((notice) => notice.kind),
        ['refused'],
      );
    });

    it('keeps deciding the other commands when one throws, and still flushes', async () => {
      append(...brewing('b1', 60), ...brewing('b2', 60));
      // An invalid date from the runner makes decide throw for b1's stall.
      progress.set(attemptKey.encode(plan('b1')), {
        lastProgressAt: new Date(Number.NaN),
        turnsWithoutProgress: 60,
      });
      progress.set(attemptKey.encode(plan('b2')), {
        lastProgressAt: at(1),
        turnsWithoutProgress: 60,
      });
      const stateBranch = fakeBranch();
      now = at(2);
      const report = await supervisor({ stateBranch })
        .tick()
        .catch((error: unknown) => error);
      assert.deepStrictEqual(report, { appended: 1, flush: { kind: 'unchanged' } });
      assert.equal(batchOf(store, 'b1').lane.kind, 'brewing');
      assert.equal(batchOf(store, 'b2').lane.kind, 'stuck');
      assert.equal(stateBranch.calls, 1);
      const [failed, ...others] = notices;
      assert.deepStrictEqual(others, []);
      assert.ok(
        failed?.kind === 'command_failed' &&
          failed.command.kind === 'stall' &&
          failed.command.batchId === 'b1' &&
          failed.error instanceof RangeError,
        String(failed?.kind),
      );
    });

    it('flushes even when the tick fails', async () => {
      const failure = new Error('database is locked');
      const broken: EventStore = {
        ...store,
        batchesPastDeadline: () => {
          throw failure;
        },
      };
      const stateBranch = fakeBranch();
      await assert.rejects(supervisor({ store: broken, stateBranch }).tick(), failure);
      assert.equal(stateBranch.calls, 1);
    });

    it('reports a command decide refuses, and still releases the expired leases', async () => {
      append(...brewing('b1', 60, 'gone'));
      const key = attemptKey.encode(plan('b1'));
      store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'runner-1', expiresAt: at(5) }),
      );
      now = at(5);
      assert.equal((await supervisor().tick()).appended, 0);
      assert.deepStrictEqual(notices, [
        {
          kind: 'refused',
          command: {
            kind: 'lose',
            batchId: 'b1',
            stepId: 'plan',
            attempt: 1,
            reason: `the lease of runner-1 expired at ${iso(5)}`,
          },
          reason: 'the Brewery has no recipe gone',
        },
      ]);
      assert.deepStrictEqual(store.expiredLeases(at(600)), []);
    });
  });

  describe('invariants across ticks', () => {
    for (const interval of [1, 7, 13, 59]) {
      it(`I5 and I1 hold after every tick, ticking every ${interval} minutes`, async () => {
        append(
          ...brewing('b1', 10),
          ...brewing('b2', 20),
          ...brewing('b3', 30),
          ...brewing('b4', 40),
          ...brewing('b5', 50),
          ...conditioning('b6', 30),
          ...stuck('b7', 45),
        );
        // b2's runner dies early; b3's brewer stops making progress.
        store.withTransaction((tx) =>
          tx.putLease({
            attemptKey: attemptKey.encode(plan('b2')),
            owner: 'runner-1',
            expiresAt: at(5),
          }),
        );
        progress.set(attemptKey.encode(plan('b3')), {
          lastProgressAt: at(0),
          turnsWithoutProgress: 60,
        });
        const engine = supervisor({ reminderMs: 30 * minute });
        for (let minutes = interval; minutes <= 4 * 60; minutes += interval) {
          now = at(minutes);
          await engine.tick();
          // I5: no batch is still brewing an attempt whose deadline has passed.
          for (const batch of stateOf(store).batches.values()) {
            for (const attempt of runningOf(batch)) {
              assert.ok(
                Date.parse(attempt.deadlineAt) > now.getTime(),
                `${batch.id} at ${minutes}`,
              );
            }
          }
          assertI1(store, now);
        }
        for (const batchId of ['b1', 'b2', 'b3', 'b4', 'b5', 'b7']) {
          assert.equal(batchOf(store, batchId).lane.kind, 'stuck', batchId);
        }
        assert.deepStrictEqual(notices, []);
      });
    }
  });

  describe('flush', () => {
    it('flushes the state branch on every tick', async () => {
      const stateBranch = fakeBranch();
      const engine = supervisor({ stateBranch });
      await engine.tick();
      await engine.tick();
      assert.equal(stateBranch.calls, 2);
    });

    it('flushes after appending what the tick decided', async () => {
      append(...brewing('b1', 30));
      let seen = 0;
      const stateBranch = {
        flush: async (): Promise<FlushResult> => {
          seen = store.lastEventId();
          return { kind: 'pushed', through: seen, commit: 'c'.repeat(40) };
        },
      };
      now = at(30);
      const report = await supervisor({ stateBranch }).tick();
      assert.equal(seen, 5);
      assert.deepStrictEqual(report, {
        appended: 1,
        flush: { kind: 'pushed', through: 5, commit: 'c'.repeat(40) },
      });
    });

    it('reports a failed flush on every tick, and once that it is overdue', async () => {
      const failed = { kind: 'failed', reason: 'could not resolve host' } as const;
      const stateBranch = fakeBranch(failed, failed, failed, failed);
      const engine = supervisor({ stateBranch, flushDeadlineMs: 10 * minute });
      for (const minutes of [0, 5, 10, 15, 20]) {
        now = at(minutes);
        await engine.tick();
      }
      const flushFailed = { kind: 'flush_failed', reason: 'could not resolve host' };
      assert.deepStrictEqual(notices, [
        flushFailed,
        flushFailed,
        flushFailed,
        { kind: 'flush_overdue', since: t0 },
        flushFailed,
      ]);
    });

    it('counts a flush that throws as failed', async () => {
      const engine = supervisor({ stateBranch: fakeBranch(new Error('git diff failed')) });
      assert.deepStrictEqual((await engine.tick()).flush, {
        kind: 'failed',
        reason: 'git diff failed',
      });
      assert.deepStrictEqual(notices, [{ kind: 'flush_failed', reason: 'git diff failed' }]);
    });

    it('rejects the tick with a StateBranchStopError', async () => {
      const stop = new StateBranchStopError('Another engine pushed to the state branch');
      const engine = supervisor({ stateBranch: fakeBranch(stop) });
      await assert.rejects(engine.tick(), (error) => error === stop);
    });
  });

  describe('run', () => {
    it('ticks every interval until stopped', async () => {
      append(...brewing('b1', 30));
      const { timer, pending, fire } = fakeTimer();
      // How many ticks are scheduled while a tick runs: none, or ticks could overlap.
      const scheduledDuringTick: number[] = [];
      const stateBranch = {
        flush: async (): Promise<FlushResult> => {
          // Counted after an await, as a real flush would be still running then.
          await Promise.resolve();
          scheduledDuringTick.push(pending.size);
          return { kind: 'unchanged' };
        },
      };
      const engine = supervisor({ timer, stateBranch, intervalMs: 5000 });
      const running = engine.run();
      assert.deepStrictEqual(
        [...pending.values()].map(({ ms }) => ms),
        [5000],
      );
      now = at(30);
      await fire();
      assert.equal(batchOf(store, 'b1').lane.kind, 'stuck');
      await fire();
      assert.deepStrictEqual(scheduledDuringTick, [0, 0], 'no tick is scheduled while one runs');
      assert.equal(pending.size, 1, 'the next tick is scheduled once the last one finished');
      engine.stop();
      assert.equal(pending.size, 0);
      await running;
    });

    it('schedules no tick after a stop that arrives while a tick runs', async () => {
      const { timer, pending, fire } = fakeTimer();
      let engine: Supervisor | undefined;
      const stateBranch = {
        flush: async (): Promise<FlushResult> => {
          engine?.stop();
          return { kind: 'unchanged' };
        },
      };
      engine = supervisor({ timer, stateBranch });
      const running = engine.run();
      await fire();
      assert.equal(pending.size, 0);
      await running;
    });

    it('runs one chain of ticks when run follows a stop while a tick runs', async () => {
      const { timer, pending, fire } = fakeTimer();
      let engine: Supervisor | undefined;
      let restarted: Promise<void> | undefined;
      const stateBranch = {
        flush: async (): Promise<FlushResult> => {
          if (restarted === undefined) {
            engine?.stop();
            restarted = engine?.run();
          }
          return { kind: 'unchanged' };
        },
      };
      engine = supervisor({ timer, stateBranch });
      const first = engine.run();
      await fire();
      await first;
      assert.equal(pending.size, 1, 'only the new run schedules a tick');
      engine.stop();
      assert.equal(pending.size, 0);
      await restarted;
    });

    it('never overlaps a tick of a new run with one still flushing', async () => {
      const { timer, fire } = fakeTimer();
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      let release = (): void => {};
      let flushes = 0;
      const stateBranch = {
        flush: async (): Promise<FlushResult> => {
          flushes++;
          if (flushes === 1) await new Promise<void>((resolve) => (release = resolve));
          return { kind: 'unchanged' };
        },
      };
      const engine = supervisor({ timer, stateBranch });
      const first = engine.run();
      const slowTick = fire();
      await settle();
      engine.stop();
      await first;
      const second = engine.run();
      const nextTick = fire();
      await settle();
      assert.equal(flushes, 1, 'the new run waits for the tick in flight');
      release();
      await slowTick;
      await nextTick;
      assert.equal(flushes, 2);
      engine.stop();
      await second;
    });

    it('settles the earlier run when run is called again', async () => {
      const engine = supervisor();
      let settled = false;
      void engine.run().then(() => {
        settled = true;
      });
      const second = engine.run();
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(settled, 'the first run promise settles');
      engine.stop();
      await second;
    });

    it('keeps ticking when the report itself throws', async () => {
      const { timer, pending, fire } = fakeTimer();
      const engine = supervisor({
        timer,
        stateBranch: fakeBranch({ kind: 'failed', reason: 'could not resolve host' }),
        report: () => {
          throw new Error('the logger is down');
        },
      });
      const running = engine.run();
      await fire().catch(() => undefined);
      assert.equal(pending.size, 1, 'the next tick is scheduled');
      engine.stop();
      await running;
    });

    it('stops at a StateBranchStopError and rejects with it', async () => {
      const { timer, pending, fire } = fakeTimer();
      const stop = new StateBranchStopError('the branch was rewritten');
      const engine = supervisor({ timer, stateBranch: fakeBranch(stop) });
      const running = engine.run();
      await fire();
      await assert.rejects(running, (error) => error === stop);
      assert.equal(pending.size, 0);
    });

    it('reports a tick that throws and runs the next one', async () => {
      const { timer, pending, fire } = fakeTimer();
      const failure = new Error('database is locked');
      let calls = 0;
      const flaky: EventStore = {
        ...store,
        batchesPastDeadline: (when) => {
          if (calls++ === 0) throw failure;
          return store.batchesPastDeadline(when);
        },
      };
      const engine = supervisor({ timer, store: flaky });
      const running = engine.run();
      await fire();
      assert.deepStrictEqual(notices, [{ kind: 'tick_failed', error: failure }]);
      assert.equal(pending.size, 1);
      await fire();
      assert.equal(calls, 2);
      engine.stop();
      await running;
    });

    it('runs on the real timer by default', { timeout: 2000 }, async () => {
      const stateBranch = fakeBranch();
      const engine = createSupervisor({
        store,
        stateBranch,
        recipes,
        progress: { progress: () => undefined },
        clock: () => now,
        intervalMs: 1,
      });
      const running = engine.run();
      while (stateBranch.calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      engine.stop();
      await running;
    });
  });
});
