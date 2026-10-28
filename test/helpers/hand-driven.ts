// A run of the real driver (`openDriver`) whose attempts end when the test says, for the chaos tests
// of a person's command or a closed usage window under kills (#615): an event store in memory, a
// command log for what people say, a clock the test moves a minute per tick, and a restart that
// kills the driver and its runner and opens new ones on the same store.

import assert from 'node:assert/strict';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command, Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverOptions, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Recipes } from '../../src/engine/recipes.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from './brewing.ts';
import { fakeLock } from './fake-lock.ts';

const minute = 60_000;

export const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

/** A runner whose attempts end when the test says; a stopped one ends cancelled. */
const handRunner = (t0: Date) => {
  const running = new Map<string, { ref: AttemptRef; end: (end: AttemptEnd) => void }>();
  const brewer: BrewerRunner = {
    start: ({ ref }) => {
      const key = attemptKey.encode(ref);
      const ended = new Promise<AttemptEnd>((end) => running.set(key, { ref, end }));
      return {
        ended,
        stop: () => {
          running.get(key)?.end({ ending: { kind: 'cancelled' } });
          running.delete(key);
        },
      };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
  /** Ends each running attempt for which `pick` says so, with what `ending` gives. */
  const endSome = (
    pick: (ref: AttemptRef) => boolean,
    ending: (ref: AttemptRef) => Ending = () => succeeded,
  ): void => {
    for (const [key, { ref, end }] of [...running]) {
      if (!pick(ref)) continue;
      running.delete(key);
      end({ ending: ending(ref) });
    }
  };
  const runsOf = (batchIds: ReadonlySet<string>): number =>
    [...running.values()].filter(({ ref }) => batchIds.has(ref.batchId)).length;
  return { brewer, endSome, runsOf, count: () => running.size };
};

export interface HandDrivenOptions {
  /** When the run starts. */
  t0: Date;
  recipes: Recipes;
  /** More options of each driver it opens, such as its zone or model family. */
  driver?: Partial<DriverOptions>;
}

/** Opens the run's first driver; `close` closes the last one and the store. */
export const handDrivenRun = async ({ t0, recipes, driver: more = {} }: HandDrivenOptions) => {
  const store: EventStore = openSqliteEventStore(':memory:');
  let now = t0;
  const log: CommandLog = createCommandLog({ store, recipes });
  let runner = handRunner(t0);
  const open = (): Promise<Driver> =>
    openDriver({
      store,
      runner: runner.brewer,
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      ...more,
    });
  let driver = await open();
  return {
    store,
    log,
    now: (): Date => now,
    /** Moves the clock to `at`, without a tick. */
    skipTo: (at: Date): void => {
      now = at;
    },
    /** Issues `command` now, which must be accepted. */
    accept: (command: Command): void => {
      const decision = log.issue(command, now);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    },
    /** A minute on, and the driver's tick. */
    tick: async (): Promise<void> => {
      now = new Date(now.getTime() + minute);
      await driver.tick();
    },
    /** Kills the driver: its runs' ends are not recorded, so the new one loses them. */
    restart: async (): Promise<void> => {
      driver.close();
      runner = handRunner(t0);
      driver = await open();
    },
    endSome: (...args: Parameters<typeof runner.endSome>): void => runner.endSome(...args),
    /** How many attempts of `batchIds` the current runner runs. */
    runsOf: (batchIds: ReadonlySet<string>): number => runner.runsOf(batchIds),
    /** How many attempts the current runner runs. */
    count: (): number => runner.count(),
    close: (): void => {
      driver.close();
      store.close();
    },
  };
};
