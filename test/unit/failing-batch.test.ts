// A batch that keeps failing is marked after an hour, and Stuck when it brews (#883, ADR 0335): a
// driver on an in-memory store with a clock the test moves, and a throw at one site of one batch.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { breweryCloseEffects } from '../../src/engine/brewery-closes.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import {
  type Driver,
  type DriverEffects,
  type DriverNotice,
  type DriverOptions,
  openDriver,
} from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { combineEffects } from '../../src/engine/effects.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { State } from '../../src/engine/fold.ts';
import type { Recipe } from '../../src/engine/recipes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const minute = 60_000;
const t0 = new Date('2026-11-06T12:00:00.000Z');
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * minute);
const pullRequest = 'https://github.com/acme/web/pull/31';
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const plan = (batchId: string): AttemptRef => ({ batchId, stepId: 'plan', attempt: 1 });
const who = { by: 'ada', via: 'terminal' } as const;

/** Attempts that run until a person's Stuck stops them. */
const quietRunner = (): BrewerRunner & { started: AttemptRef[] } => {
  const running = new Map<string, (end: AttemptEnd) => void>();
  const started: AttemptRef[] = [];
  return {
    started,
    start: ({ ref }: AttemptStart) => {
      started.push(ref);
      const key = attemptKey.encode(ref);
      return {
        ended: new Promise<AttemptEnd>((resolve) => running.set(key, resolve)),
        stop: () => {
          running.get(key)?.({ ending: { kind: 'cancelled' } });
          running.delete(key);
        },
      };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
};

/** One comment per succeeded attempt of the batch. */
const commentsDue = (state: State, batchId: string) =>
  [...(state.batches.get(batchId)?.steps.values() ?? [])].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded'
        ? [{ batchId, stepId: step.id, attempt: attempt.attempt, effect: 'comment' }]
        : [],
    ),
  );

describe('a batch that keeps failing (ADR 0335)', () => {
  let store: EventStore;
  let now: Date;
  let intake: CommandLog;
  let notices: DriverNotice[];
  // What makes `bad` throw: a brewing batch's every reading of its recipe.
  let readingBroken: boolean;
  // What makes `bad` throw only when a lost attempt's loss is decided.
  let retryBroken: boolean;
  // The message `due` of `effects` throws for a batch in `unread`, and `apply` for one in `refused`.
  let message: string;
  // What an effect's `apply` throws, where a test tells it from a reading's throw.
  let effectMessage: string | undefined;
  let unread: Set<string>;
  let refused: Set<string>;
  let applied: string[];
  const drivers: Driver[] = [];

  const base = fakeRecipe({ steps: ['plan', 'implement'] });
  const breaks =
    <T extends unknown[], R>(read: (...args: T) => R) =>
    (...args: T): R => {
      if (readingBroken) throw new Error(message);
      return read(...args);
    };
  // Deadlines far off, so the mark's hour is met first.
  const pint: Recipe = { ...base, deadlineMs: () => 10 * hour };
  const bad: Recipe = {
    ...pint,
    interactive: breaks(pint.interactive),
    stall: breaks(pint.stall),
    mayRetry: (...args) => {
      if (retryBroken) throw new Error(message);
      return pint.mayRetry(...args);
    },
  };
  const recipes = fakeRecipes({
    pint,
    bad,
    merging: fakeRecipe({ steps: ['plan'], pullRequests: [pullRequest] }),
  });
  const effects: DriverEffects = {
    due: (state, batchId) => {
      if (unread.has(batchId)) throw new Error(message);
      return commentsDue(state, batchId);
    },
    target: {
      find: async () => undefined,
      apply: async (key) => {
        const { batchId } = effectKey.decode(key);
        if (refused.has(batchId)) throw new Error(effectMessage ?? message);
        applied.push(key);
        return { key };
      },
    },
  };

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    intake = createCommandLog({ store, recipes });
    notices = [];
    readingBroken = false;
    retryBroken = false;
    message = 'boom';
    effectMessage = undefined;
    unread = new Set();
    refused = new Set();
    applied = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = intake.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  /** Orders `batchId` and routes it to `recipe`: plan#1 is scheduled. */
  const order = (batchId: string, recipe = 'pint'): void => {
    const issue = Number(batchId.slice(1));
    accept({ kind: 'order', batchId, order: { issue } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
  };
  /** Orders `batchId` and brews it on tap, with no driver's attempt. */
  const onTap = (batchId: string): void => {
    order(batchId, 'merging');
    accept({ kind: 'record', event: { type: 'step.started', ...plan(batchId) } });
    accept({ kind: 'finish', ...plan(batchId), ending: succeeded });
    assert.equal(intake.state().batches.get(batchId)?.lane.kind, 'on_tap');
  };
  const open = async (options: Partial<DriverOptions> = {}): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: quietRunner(),
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects,
      report: (notice) => notices.push(notice),
      ...options,
    });
    drivers.push(driver);
    return driver;
  };
  /** Ticks at each of `minutes` from t0. */
  const ticksAt = async (driver: Driver, ...minutes: number[]): Promise<void> => {
    for (const each of minutes) {
      now = at(each);
      await driver.tick();
    }
  };
  const batchOf = (batchId: string) => intake.state().batches.get(batchId);
  const marks = (batchId: string) =>
    store
      .eventsAfter(0)
      .map(({ event }) => event)
      .filter(
        (event) =>
          (event.type === 'batch.failing' || event.type === 'batch.recovered') &&
          event.batchId === batchId,
      )
      .map(({ type }) => type);
  /** `batchId` started on `bad` by a driver, and then every reading of its recipe throws. */
  const brewingThenBroken = async (batchId: string, driver: Driver): Promise<void> => {
    order(batchId, 'bad');
    await driver.tick();
    assert.equal(batchOf(batchId)?.steps.get('plan')?.attempts.get(1)?.phase, 'started');
    readingBroken = true;
  };

  describe('the hour', () => {
    it('does not mark a batch that has failed for less than an hour', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 30, 59);
      assert.equal(batchOf('b1')?.failing, undefined);
      assert.deepStrictEqual(marks('b1'), []);
      await ticksAt(driver, 60);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('marks a batch that has failed for an hour, with its pass, its summary and since when', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 30, 60);
      assert.deepStrictEqual(batchOf('b1')?.failing, {
        pass: 'effects',
        summary: 'boom',
        since: t0.toISOString(),
      });
    });

    it('records the mark once while the batch goes on failing', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60, 61, 120, 200);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('marks no other batch, and the other goes on', async () => {
      onTap('b1');
      onTap('b2');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      assert.notEqual(batchOf('b1')?.failing, undefined);
      assert.equal(batchOf('b2')?.failing, undefined);
      assert.equal(applied.length, 1);
    });

    it('keeps one clock for a batch whose failure moves from the supervisor to the effects', async () => {
      const driver = await open();
      await brewingThenBroken('b1', driver);
      await ticksAt(driver, 0, 30);
      readingBroken = false;
      unread.add('b1');
      message = 'later';
      await ticksAt(driver, 31, 60);
      assert.deepStrictEqual(batchOf('b1')?.failing, {
        pass: 'effects',
        summary: 'later',
        since: t0.toISOString(),
      });
    });

    it('a tick that rejects marks nothing and keeps the clock', async () => {
      onTap('b1');
      unread.add('b1');
      let stops = false;
      const driver = await open({
        stateBranch: {
          flush: async () => {
            if (stops) throw new StateBranchStopError('another engine pushed');
            return { kind: 'unchanged' };
          },
        },
      });
      await ticksAt(driver, 0);
      stops = true;
      now = at(60);
      await assert.rejects(driver.tick(), StateBranchStopError);
      assert.deepStrictEqual(marks('b1'), []);
      stops = false;
      await ticksAt(driver, 61);
      assert.equal(batchOf('b1')?.failing?.since, t0.toISOString());
    });

    it('starts the hour again after a tick that went clean', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 30);
      unread.clear();
      await ticksAt(driver, 31);
      unread.add('b1');
      await ticksAt(driver, 32, 91);
      assert.equal(batchOf('b1')?.failing, undefined);
      await ticksAt(driver, 92);
      assert.equal(batchOf('b1')?.failing?.since, at(32).toISOString());
    });

    it('counts a supervisor that keeps failing on a command of the batch', async () => {
      const driver = await open();
      await brewingThenBroken('b1', driver);
      readingBroken = false;
      // Its lease ran out, and deciding its loss reads the recipe.
      driver.close();
      drivers.length = 0;
      store.withTransaction((tx) =>
        tx.putLease({
          attemptKey: attemptKey.encode(plan('b1')),
          owner: 'gone',
          expiresAt: at(-1),
        }),
      );
      const next = await open({ lock: () => fakeLock('next') });
      retryBroken = true;
      // The lease of the driver before it ran out by the first of these.
      await ticksAt(next, 6, 66);
      assert.equal(batchOf('b1')?.failing?.pass, 'supervisor');
      assert.ok(notices.some((notice) => notice.kind === 'command_failed'));
      const lane = batchOf('b1')?.lane;
      assert.ok(lane?.kind === 'stuck' && lane.reason.kind === 'failing', JSON.stringify(lane));
      assert.equal(lane.reason.stepId, 'plan');
    });
  });

  describe('its summary', () => {
    const summaryOf = async (text: string): Promise<string | undefined> => {
      onTap('b1');
      unread.add('b1');
      message = text;
      const driver = await open();
      await ticksAt(driver, 0, 60);
      return batchOf('b1')?.failing?.summary;
    };

    it('keeps at most 120 characters', async () => {
      assert.equal(await summaryOf('x'.repeat(500)), 'x'.repeat(120));
    });

    it('keeps the first line', async () => {
      assert.equal(await summaryOf('first\nsecond'), 'first');
    });

    it('ends the line at a line separator too, so it cannot forge a line of the output', async () => {
      assert.equal(await summaryOf(`first${String.fromCodePoint(0x2028)}second`), 'first');
    });

    it('says so when the error has no message, since the event refuses an empty one', async () => {
      assert.equal(await summaryOf('   '), 'the batch failed without a message');
    });
  });

  describe('what the review found in its summary', () => {
    const summaryOf = async (text: string): Promise<string | undefined> => {
      onTap('b1');
      unread.add('b1');
      message = text;
      const driver = await open();
      await ticksAt(driver, 0, 60);
      return batchOf('b1')?.failing?.summary;
    };
    const token = `ghp_${'a'.repeat(36)}`;
    const leftOut = 'the failure reads like a secret, so its text is left out';

    it('ends the line at a paragraph separator (regression test)', async () => {
      assert.equal(await summaryOf(`first${String.fromCodePoint(0x2029)}second`), 'first');
    });

    it('ends the line at a bare carriage return', async () => {
      assert.equal(await summaryOf('first\rsecond'), 'first');
    });

    it('ends the line at a next line', async () => {
      assert.equal(await summaryOf(`first${String.fromCodePoint(0x85)}second`), 'first');
    });

    it('leaves out a text that reads like a secret', async () => {
      assert.equal(await summaryOf(`the host said ${token}`), leftOut);
    });

    it('leaves out a text whose secret the 120 characters would cut in two', async () => {
      assert.equal(await summaryOf(`${'x'.repeat(105)} ${token}`), leftOut);
    });
  });

  describe('a reading and an effect that fail together', () => {
    it('names the reading on its Stuck, though the effect failed last', async () => {
      order('b1', 'bad');
      accept({ kind: 'record', event: { type: 'step.started', ...plan('b1') } });
      accept({ kind: 'finish', ...plan('b1'), ending: succeeded });
      refused.add('b1');
      effectMessage = 'host down';
      const driver = await open();
      await ticksAt(driver, 0);
      readingBroken = true;
      await ticksAt(driver, 0, 60);
      const lane = batchOf('b1')?.lane;
      assert.ok(lane?.kind === 'stuck' && lane.reason.kind === 'failing', JSON.stringify(lane));
      assert.equal(lane.reason.pass, 'supervisor');
      assert.equal(lane.reason.summary, 'boom');
      assert.equal(batchOf('b1')?.failing?.summary, 'boom');
    });
  });

  describe('while a takeover holds its effects back', () => {
    it('records no recovery of effects it never tried', async () => {
      order('b1');
      accept({ kind: 'record', event: { type: 'step.started', ...plan('b1') } });
      accept({ kind: 'finish', ...plan('b1'), ending: succeeded });
      refused.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
      now = at(60);
      accept({
        kind: 'take_over',
        batchId: 'b1',
        ...who,
        from: 'cellar',
        to: 'cellar',
        until: at(70).toISOString(),
      });
      await ticksAt(driver, 61);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });
  });

  describe('who writes it', () => {
    it('records nothing from a driver that does not take a free batch', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open({ takes: () => false });
      await ticksAt(driver, 0, 60);
      assert.deepStrictEqual(marks('b1'), []);
      assert.deepStrictEqual(driver.held(), []);
      const taker = await open({ lock: () => fakeLock('taker') });
      await ticksAt(taker, 60, 120);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
      assert.deepStrictEqual(taker.held(), [], "a mark does not make the batch this driver's");
    });

    it('lets a free batch it marked be, so its lease lapses and a person can brew it', async () => {
      accept({ kind: 'order', batchId: 'b1', order: { issue: 1 } });
      accept({ kind: 'wait', batchId: 'b1', on: { kind: 'merge', pullRequest } });
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      assert.notEqual(batchOf('b1')?.failing, undefined);
      assert.deepStrictEqual(driver.held(), []);
      assert.deepStrictEqual(
        store.batchLeases(at(60)).map(({ batchId }) => batchId),
        ['b1'],
        'the write held it, so no other driver wrote beside it',
      );
      await ticksAt(driver, 61, 62, 63, 64, 66);
      assert.deepStrictEqual(store.batchLeases(at(66)), []);
    });

    it("records nothing of a brewing batch this driver's supervisor reads but does not take", async () => {
      order('b1', 'bad');
      readingBroken = true;
      const driver = await open({ takes: () => false });
      await ticksAt(driver, 0, 60);
      assert.ok(notices.some((notice) => notice.kind === 'batch_failed'));
      assert.deepStrictEqual(marks('b1'), []);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      const taker = await open({ lock: () => fakeLock('taker') });
      await ticksAt(taker, 60, 120);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('records nothing of a batch another driver holds', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0);
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'other', expiresAt: at(120) }),
      );
      await ticksAt(driver, 60);
      assert.deepStrictEqual(marks('b1'), []);
      // Its lease ran out, so the batch is this driver's again, whose hour starts over: it saw no
      // failure of a batch another driver held.
      await ticksAt(driver, 121, 181);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('records one mark when two drivers could, the one that holds the batch', async () => {
      onTap('b1');
      unread.add('b1');
      const holder = await open();
      await ticksAt(holder, 0);
      const second = await open({ lock: () => fakeLock('second') });
      await ticksAt(second, 0);
      await ticksAt(second, 60);
      await ticksAt(holder, 60);
      await ticksAt(second, 61);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('a mark that cannot be written stops no other batch, and is tried again', async () => {
      onTap('b1');
      onTap('b2');
      unread.add('b1');
      unread.add('b2');
      let appendFails = true;
      const faulty: EventStore = {
        ...store,
        withTransaction: (work) =>
          store.withTransaction((tx) =>
            work({
              ...tx,
              append: (event) => {
                const refuses =
                  appendFails && event.type === 'batch.failing' && event.batchId === 'b1';
                if (refuses) throw new Error('disk full');
                return tx.append(event);
              },
            }),
          ),
      };
      const driver = await open({ store: faulty });
      await ticksAt(driver, 0, 60);
      assert.equal(batchOf('b1')?.failing, undefined);
      assert.notEqual(batchOf('b2')?.failing, undefined, "b2's mark is still written");
      appendFails = false;
      await ticksAt(driver, 61);
      assert.notEqual(batchOf('b1')?.failing, undefined);
    });

    it('says a mark that cannot be written once, not on every tick', async () => {
      onTap('b1');
      unread.add('b1');
      const faulty: EventStore = {
        ...store,
        withTransaction: (work) =>
          store.withTransaction((tx) =>
            work({
              ...tx,
              append: (event) => {
                if (event.type === 'batch.failing') throw new Error('disk full');
                return tx.append(event);
              },
            }),
          ),
      };
      const driver = await open({ store: faulty });
      await ticksAt(driver, 0, 60, 61, 62);
      assert.equal(notices.filter(({ kind }) => kind === 'command_failed').length, 1);
    });

    it('says each batch whose mark cannot be written, and again once one was written', async () => {
      onTap('b1');
      onTap('b2');
      unread.add('b1');
      unread.add('b2');
      let appendFails = true;
      const faulty: EventStore = {
        ...store,
        withTransaction: (work) =>
          store.withTransaction((tx) =>
            work({
              ...tx,
              append: (event) => {
                if (event.type === 'batch.failing' && appendFails) throw new Error('disk full');
                return tx.append(event);
              },
            }),
          ),
      };
      const said = () => notices.filter(({ kind }) => kind === 'command_failed').length;
      const driver = await open({ store: faulty });
      await ticksAt(driver, 0, 60, 61);
      assert.equal(said(), 2);
      appendFails = false;
      await ticksAt(driver, 62);
      unread.clear();
      await ticksAt(driver, 63);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered']);
      unread.add('b1');
      appendFails = true;
      await ticksAt(driver, 64, 124);
      assert.equal(said(), 3);
    });
  });

  describe('a clean pass', () => {
    it('records that it recovered, and the mark goes', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      unread.clear();
      await ticksAt(driver, 61);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered']);
      assert.equal(batchOf('b1')?.failing, undefined);
    });

    it('records nothing for a batch that never carried the mark', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0);
      unread.clear();
      await ticksAt(driver, 1, 2);
      assert.deepStrictEqual(marks('b1'), []);
      unread.add('b1');
      await ticksAt(driver, 3, 63);
      unread.clear();
      await ticksAt(driver, 64, 65);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered']);
    });

    it('marks it again an hour after it fails again', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      unread.clear();
      await ticksAt(driver, 61);
      unread.add('b1');
      await ticksAt(driver, 62, 121);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered']);
      await ticksAt(driver, 122);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered', 'batch.failing']);
    });

    it('says nothing of a batch another driver holds, whose driver reads it', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      driver.close();
      drivers.length = 0;
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: 'b1', owner: 'other', expiresAt: at(180) }),
      );
      unread.clear();
      const next = await open({ lock: () => fakeLock('next') });
      await ticksAt(next, 61);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });
  });

  describe('a brewing batch', () => {
    it('goes Stuck at the limit, naming its step, and its run is stopped', async () => {
      const driver = await open();
      await brewingThenBroken('b1', driver);
      await ticksAt(driver, 0, 59);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      await ticksAt(driver, 60);
      const lane = batchOf('b1')?.lane;
      assert.equal(lane?.kind, 'stuck');
      assert.deepStrictEqual(lane?.kind === 'stuck' ? lane.reason : undefined, {
        kind: 'failing',
        stepId: 'plan',
        pass: 'supervisor',
        summary: 'boom',
        since: t0.toISOString(),
      });
      const attempt = batchOf('b1')?.steps.get('plan')?.attempts.get(1);
      assert.ok(attempt?.phase === 'started' && attempt.abandoned === true);
    });

    it('stays Stuck with its mark while Stuck reads clean, until a person moves it', async () => {
      const driver = await open();
      await brewingThenBroken('b1', driver);
      await ticksAt(driver, 0, 60);
      readingBroken = false;
      await ticksAt(driver, 61, 62);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
    });

    it('a batch still failing after a retry is marked and Stuck an hour later, not at once', async () => {
      const driver = await open();
      await brewingThenBroken('b1', driver);
      await ticksAt(driver, 0, 60);
      now = at(70);
      accept({ kind: 'retry', batchId: 'b1', ...who });
      await ticksAt(driver, 70, 71, 129);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      assert.equal(batchOf('b1')?.failing, undefined);
      await ticksAt(driver, 131);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
      assert.notEqual(batchOf('b1')?.failing, undefined);
    });

    it('starts a new hour from a retry whose batch still fails all through its Stuck', async () => {
      order('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60, 61);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
      now = at(62);
      accept({ kind: 'retry', batchId: 'b1', ...who });
      await ticksAt(driver, 62, 121);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      await ticksAt(driver, 122);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
    });

    it("leaves an interactive session's person at work: the mark, and no Stuck", async () => {
      order('b1', 'bad');
      const event = {
        type: 'step.started',
        ...plan('b1'),
        interactiveSince: t0.toISOString(),
      } as const;
      accept({ kind: 'record', event });
      readingBroken = true;
      const driver = await open();
      await ticksAt(driver, 0, 60, 61);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('goes Stuck once it brews, when it was marked in another lane', async () => {
      accept({ kind: 'order', batchId: 'b1', order: { issue: 1 } });
      accept({ kind: 'wait', batchId: 'b1', on: { kind: 'merge', pullRequest } });
      assert.equal(batchOf('b1')?.lane.kind, 'conditioning');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      assert.equal(batchOf('b1')?.lane.kind, 'conditioning');
      assert.notEqual(batchOf('b1')?.failing, undefined);
      accept({ kind: 'route', batchId: 'b1', recipe: 'pint', reason: 'label', source: 'label' });
      await ticksAt(driver, 61);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });
  });

  describe('a batch on tap with the mark', () => {
    it('keeps its lane, and the records of its checks and its merge go through', async () => {
      onTap('b1');
      unread.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 60);
      assert.equal(batchOf('b1')?.lane.kind, 'on_tap');
      assert.notEqual(batchOf('b1')?.failing, undefined);
      const head = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.checks_pending',
          batchId: 'b1',
          pullRequest,
          head,
          since: at(60).toISOString(),
        },
      });
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'b1', pullRequest, state: 'merged' },
      });
      assert.equal(batchOf('b1')?.pullRequestEnds?.[pullRequest], 'merged');
    });

    it('closes its Brewery issue on its merge', async () => {
      onTap('b1');
      const github = fakeGitHub();
      const brewery = 'alice/brewery';
      const closes = breweryCloseEffects({ marks: github.marks('alice'), brewery });
      const failingSource: DriverEffects = {
        due: () => {
          throw new Error('boom');
        },
        target: {
          find: async () => assert.fail('nothing of it is due'),
          apply: async () => assert.fail('nothing of it is due'),
        },
      };
      const driver = await open({ effects: combineEffects(failingSource, closes) });
      await ticksAt(driver, 0, 60);
      assert.notEqual(batchOf('b1')?.failing, undefined);
      assert.equal(github.issue(brewery, 1).state, undefined);
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'b1', pullRequest, state: 'merged' },
      });
      await ticksAt(driver, 61);
      assert.equal(github.issue(brewery, 1).state, 'closed');
      assert.notEqual(batchOf('b1')?.failing, undefined);
    });

    it('records the pass over its one effect that fails, marks it and leaves its lane', async () => {
      onTap('b1');
      refused.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 59);
      assert.equal(batchOf('b1')?.failing, undefined);
      await ticksAt(driver, 60);
      assert.equal(batchOf('b1')?.failing?.pass, 'effects');
      assert.equal(batchOf('b1')?.lane.kind, 'on_tap');
    });
  });

  describe('an effect that fails', () => {
    /** b1 past its first step, brewing its second, with plan's comment due. */
    const brewingWithAnEffectDue = async (): Promise<Driver> => {
      order('b1');
      accept({ kind: 'record', event: { type: 'step.started', ...plan('b1') } });
      accept({ kind: 'finish', ...plan('b1'), ending: succeeded });
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      return open();
    };

    it('marks a brewing batch after an hour, and never makes it Stuck', async () => {
      refused.add('b1');
      const driver = await brewingWithAnEffectDue();
      await ticksAt(driver, 0, 60, 61, 120);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
    });

    it('recovers once the effect lands', async () => {
      refused.add('b1');
      const driver = await brewingWithAnEffectDue();
      await ticksAt(driver, 0, 60);
      refused.clear();
      await ticksAt(driver, 61);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered']);
    });

    it('does not count its hour toward the Stuck of a reading that failed for less', async () => {
      refused.add('b1');
      const driver = await brewingWithAnEffectDue();
      await ticksAt(driver, 0, 30);
      unread.add('b1');
      await ticksAt(driver, 31, 60, 90);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing', 'the reading has failed for 59 minutes');
      assert.notEqual(batchOf('b1')?.failing, undefined);
      await ticksAt(driver, 91);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
    });

    it('starts the reading’s hour again when a tick reads clean, the effect still failing', async () => {
      refused.add('b1');
      unread.add('b1');
      const driver = await brewingWithAnEffectDue();
      await ticksAt(driver, 0, 30);
      unread.clear();
      await ticksAt(driver, 31);
      unread.add('b1');
      await ticksAt(driver, 32, 91);
      assert.equal(batchOf('b1')?.lane.kind, 'brewing');
      await ticksAt(driver, 92);
      assert.equal(batchOf('b1')?.lane.kind, 'stuck');
    });
  });

  describe('a restart', () => {
    const restarted = async (driver: Driver): Promise<Driver> => {
      driver.close();
      drivers.length = 0;
      return open();
    };

    it('makes the mark later, never sooner', async () => {
      onTap('b1');
      unread.add('b1');
      const first = await open();
      await ticksAt(first, 0, 59);
      const second = await restarted(first);
      await ticksAt(second, 59, 60, 118);
      assert.deepStrictEqual(marks('b1'), []);
      await ticksAt(second, 119);
      assert.equal(batchOf('b1')?.failing?.since, at(59).toISOString());
    });

    it('reads a mark from the store, adds none while it still fails, and records its recovery', async () => {
      onTap('b1');
      unread.add('b1');
      const first = await open();
      await ticksAt(first, 0, 60);
      const second = await restarted(first);
      assert.notEqual(second.state().batches.get('b1')?.failing, undefined);
      await ticksAt(second, 61, 200);
      assert.deepStrictEqual(marks('b1'), ['batch.failing']);
      unread.clear();
      await ticksAt(second, 201);
      assert.deepStrictEqual(marks('b1'), ['batch.failing', 'batch.recovered']);
    });
  });

  describe('what it prints', () => {
    const lines = (kind: DriverNotice['kind']) => notices.filter((n) => n.kind === kind).length;

    it('says an effect that keeps failing once', async () => {
      onTap('b1');
      refused.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 1, 2);
      assert.equal(lines('effect_failed'), 1);
    });

    it('says the same effect of another batch too, as the key names its effect', async () => {
      onTap('b1');
      onTap('b2');
      refused.add('b1');
      refused.add('b2');
      const driver = await open();
      await ticksAt(driver, 0, 1);
      assert.equal(lines('effect_failed'), 2);
    });

    it('says an effect again when its message changes', async () => {
      onTap('b1');
      refused.add('b1');
      const driver = await open();
      await ticksAt(driver, 0, 1);
      assert.equal(lines('effect_failed'), 1);
      message = 'another';
      await ticksAt(driver, 2);
      assert.equal(lines('effect_failed'), 2);
    });

    it('says an effect again when it fails after a pass that did not (regression test)', async () => {
      onTap('b1');
      refused.add('b1');
      let due = true;
      const driver = await open({
        effects: {
          ...effects,
          due: (state, batchId) => (due ? commentsDue(state, batchId) : []),
        },
      });
      await ticksAt(driver, 0);
      due = false;
      await ticksAt(driver, 1);
      due = true;
      await ticksAt(driver, 2);
      assert.equal(lines('effect_failed'), 2);
    });

    it('does not say a failure again when only a number in its message moved', async () => {
      onTap('b1');
      unread.add('b1');
      message = 'read failed at 12:00:01';
      const driver = await open();
      await ticksAt(driver, 0);
      message = 'read failed at 12:00:06';
      await ticksAt(driver, 1);
      assert.equal(lines('batch_effects_failed'), 1);
    });

    /** `batchId` on `bad`, started, and its lease run out: deciding its loss reads the recipe. */
    const lostOnBad = (batchId: string): void => {
      order(batchId, 'bad');
      accept({ kind: 'record', event: { type: 'step.started', ...plan(batchId) } });
      store.withTransaction((tx) =>
        tx.putLease({
          attemptKey: attemptKey.encode(plan(batchId)),
          owner: 'gone',
          expiresAt: at(-1),
        }),
      );
    };

    it("says the same command of another batch too, as the key names the batch's", async () => {
      lostOnBad('b1');
      lostOnBad('b2');
      retryBroken = true;
      const driver = await open();
      await ticksAt(driver, 0, 1);
      assert.equal(lines('command_failed'), 2);
    });

    it('says a command again when it fails after a tick that did not', async () => {
      lostOnBad('b1');
      retryBroken = true;
      const driver = await open();
      await ticksAt(driver, 0);
      assert.equal(lines('command_failed'), 1);
      // A live lease: no loss to decide, so a tick that does not fail on the command.
      const key = attemptKey.encode(plan('b1'));
      store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'gone', expiresAt: at(3) }),
      );
      await ticksAt(driver, 1);
      await ticksAt(driver, 4);
      assert.equal(lines('command_failed'), 2);
    });

    it("says a supervisor's command that keeps throwing once", async () => {
      order('b1', 'bad');
      accept({ kind: 'record', event: { type: 'step.started', ...plan('b1') } });
      store.withTransaction((tx) =>
        tx.putLease({
          attemptKey: attemptKey.encode(plan('b1')),
          owner: 'gone',
          expiresAt: at(-1),
        }),
      );
      retryBroken = true;
      const driver = await open();
      await ticksAt(driver, 0, 1, 2);
      assert.equal(lines('command_failed'), 1);
    });
  });
});
