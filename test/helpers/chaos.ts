// The chaos harness (#15, architecture §9): engine scenarios (test/helpers/simulation.ts) played
// against the real driver (`openDriver`, ADR 0044) on an event store in a file, with the driver
// killed at random points of its run's seed, inside transactions and between them, and restarted
// on the same file (ADR 0033). A kill ends everything that lived in the driver's memory: the
// driver, its supervisor, its fake runner and every attempt it ran, and its lock, which the
// operating system releases (ADR 0037). What survives is the database and the code host the
// effects went to. No process is started or killed: the driver is this test's own code, and a
// kill is an exception it cannot catch.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { type DriverLock, DriverRunningError } from '../../src/engine/driver-lock.ts';
import type { EffectTarget } from '../../src/engine/effects.ts';
import type { EffectKey, EventStore, EventStoreTransaction } from '../../src/engine/event-store.ts';
import type { Batch, State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from './brewing.ts';
import {
  generateScenario,
  type Move,
  type MoveSource,
  type Play,
  recording,
  type Scenario,
  scenarioLimits,
  seededRandom,
} from './event-sequences.ts';
import { fakeBrewerRunner } from './fake-brewer-runner.ts';
import {
  describeCommand,
  describeEvent,
  describePlay,
  forEachSeedAsync,
  noted,
} from './property.ts';
import { behaviourOf, recipes, reminderMs, routingMs, t0 } from './simulation.ts';

export const killPoints = [
  'in a transaction',
  'after a commit',
  'before an effect reached its target',
  'after an effect reached its target',
] as const;
export type KillPoint = (typeof killPoints)[number];

/** Thrown at a kill point, and by everything a dead driver touches afterwards. */
export class EngineKilled extends Error {
  constructor(point: KillPoint | 'dead') {
    super(point === 'dead' ? 'The engine is dead' : `The engine was killed ${point}`);
    this.name = 'EngineKilled';
  }
}

/** A kill as it happened: at which point, during which move (0 before the first), of which driver. */
export interface Kill {
  /** The number of the kill point, counted from the start of the run across restarts. */
  at: number;
  point: KillPoint;
  move: number;
  /** The owner of the driver that died. */
  driver: string;
}

/**
 * When to kill a driver: at each kill point it dies with the chance of that kind of point, drawn
 * from a random stream of `seed`'s own, at most `maxKills` times per run. Kills spread over the
 * whole run, and the windows around an effect, which few points cover, get a higher chance.
 */
export interface KillPlan {
  seed: number;
  chance: Readonly<Record<KillPoint, number>>;
  maxKills: number;
}

export const killPlan = (seed: number): KillPlan => ({
  seed,
  chance: {
    'in a transaction': 0.015,
    'after a commit': 0.015,
    'before an effect reached its target': 0.05,
    'after an effect reached its target': 0.05,
  },
  maxKills: 6,
});

/**
 * The life of one driver process, from its start to its kill. Once dead it stays dead: whatever
 * the dead driver still had in flight throws when it touches the store or the code host, also
 * after a new process of its owner started.
 */
export interface Life {
  readonly driver: string;
  readonly dead: boolean;
  /** Passes a kill point; throws when the driver dies here or is already dead. */
  point(point: KillPoint): void;
  /** Throws when the driver is dead. */
  alive(): void;
}

/** Counts kill points across every driver of a run and kills a driver at the planned ones. */
const killer = (plan: KillPlan) => {
  const random = seededRandom(plan.seed ^ 0x5eed_c4a0);
  let passed = 0;
  const kills: Kill[] = [];
  let move = 0;
  const life = (driver: string): Life => {
    let dead = false;
    const alive = (): void => {
      if (dead) throw new EngineKilled('dead');
    };
    return {
      driver,
      get dead() {
        return dead;
      },
      alive,
      point: (point) => {
        alive();
        passed++;
        if (kills.length === plan.maxKills || !random.chance(plan.chance[point])) return;
        dead = true;
        kills.push({ at: passed, point, move, driver });
        throw new EngineKilled(point);
      },
    };
  };
  return {
    kills,
    life,
    moved: (): void => {
      move++;
    },
  };
};

/**
 * The store as the driver of `life` sees it: `inner` with a kill point before every write in a
 * transaction and after every commit. A kill in a transaction throws inside it, so the store rolls
 * it back: what a database shows after its process died with a transaction open.
 */
const killableStore = (inner: EventStore, life: Life): EventStore => {
  const writes = (tx: EventStoreTransaction): EventStoreTransaction => ({
    append: (event) => {
      life.point('in a transaction');
      return tx.append(event);
    },
    putLease: (lease) => {
      life.point('in a transaction');
      tx.putLease(lease);
    },
    releaseLease: (key) => {
      life.point('in a transaction');
      tx.releaseLease(key);
    },
    batchLease: (batchId) => {
      life.alive();
      return tx.batchLease(batchId);
    },
    putBatchLease: (lease) => {
      life.point('in a transaction');
      tx.putBatchLease(lease);
    },
    releaseBatchLease: (batchId) => {
      life.point('in a transaction');
      tx.releaseBatchLease(batchId);
    },
    recordEffect: (key, result) => {
      life.point('in a transaction');
      tx.recordEffect(key, result);
    },
    markPushed: (marker) => {
      life.point('in a transaction');
      tx.markPushed(marker);
    },
  });
  const read =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      life.alive();
      return fn(...args);
    };
  return {
    withTransaction: (fn) => {
      life.alive();
      const result = inner.withTransaction((tx) => fn(writes(tx)));
      life.point('after a commit');
      return result;
    },
    eventsAfter: read(inner.eventsAfter),
    batchesPastDeadline: read(inner.batchesPastDeadline),
    currentLeases: read(inner.currentLeases),
    expiredLeases: read(inner.expiredLeases),
    batchLeases: read(inner.batchLeases),
    replay: read(inner.replay),
    lastEventId: read(inner.lastEventId),
    pushedThrough: read(inner.pushedThrough),
    restore: read(inner.restore),
    findEffect: read(inner.findEffect),
    // The run's connection outlives every driver.
    close: () => {},
  };
};

/**
 * The drivers' locks (ADR 0037): one per owner, refused to a second process while its holder
 * lives. A kill frees it, as the operating system frees the file lock of a process that died.
 */
const fakeLocks = () => {
  const holders = new Map<string, { life: Life; released: boolean }>();
  return {
    take: (life: Life): DriverLock => {
      const owner = life.driver;
      const path = join('drivers', `${owner}.lock`);
      const holder = holders.get(owner);
      if (holder !== undefined && !holder.released && !holder.life.dead) {
        throw new DriverRunningError(owner, path, undefined);
      }
      const taken = { life, released: false };
      holders.set(owner, taken);
      return {
        owner,
        path,
        get held() {
          return !taken.released && !life.dead;
        },
        release: () => {
          taken.released = true;
        },
      };
    },
  };
};

/**
 * The code host the effects land on. Like GitHub, it applies what it is asked to as often as it
 * is asked, and finds an effect by the key it carries (a marker in a comment's body).
 */
export const fakeCodeHost = () => {
  /** Every result applied, by effect key, in order. */
  const applied = new Map<string, unknown[]>();
  let comments = 0;
  let found = 0;
  const target = (life: Life): EffectTarget => ({
    find: async (key) => {
      life.alive();
      const [first] = applied.get(key) ?? [];
      if (first === undefined) return undefined;
      found++;
      return { result: first };
    },
    apply: async (key) => {
      life.point('before an effect reached its target');
      const result = { comment: ++comments };
      applied.set(key, [...(applied.get(key) ?? []), result]);
      // The comment exists; the driver dies before it hears so.
      life.point('after an effect reached its target');
      return result;
    },
  });
  return {
    applied,
    target,
    /** How often an effect was found here rather than applied: a kill's window closed. */
    get found() {
      return found;
    },
  };
};
export type FakeCodeHost = ReturnType<typeof fakeCodeHost>;

/** The effect each succeeded attempt has: a comment on its issue, keyed by the attempt. */
export const progressComment = 'progress_comment';

/** The effects `batch` calls for: one per succeeded attempt. */
const batchEffectsDue = (batch: Batch): EffectKey[] =>
  [...batch.steps.values()].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded'
        ? [
            {
              batchId: batch.id,
              stepId: step.id,
              attempt: attempt.attempt,
              effect: progressComment,
            },
          ]
        : [],
    ),
  );

/** The effects `state` calls for: one per succeeded attempt. */
export const effectsDue = (state: State): EffectKey[] =>
  [...state.batches.values()].flatMap(batchEffectsDue);

// A kill ends the process, not the machine: what SQLite handed the OS survives it whatever
// `synchronous` says, so the harness skips the fsyncs that would only guard against power loss.
const openDatabase = (file: string, options: ConstructorParameters<typeof DatabaseSync>[1]) => {
  const db = new DatabaseSync(file, options);
  db.exec('PRAGMA synchronous = OFF');
  return db;
};

/** The drivers of a chaos run: a fresh process of a driver starts on the same database after every kill. */
export interface ChaosEngine {
  now(): Date;
  /** The folded state of every committed event. */
  state(): State;
  /** The store as a process beside the drivers sees it; never killed. */
  store(): EventStore;
  events(): Event[];
  /** Plays one move; a kill during it restarts the driver. False when the driver died in it. */
  play(move: Move): Promise<boolean>;
  /** Applies the effects that are due and not in the ledger. */
  applyEffects(): Promise<void>;
  readonly kills: readonly Kill[];
  /** How often an effect was found on the code host rather than applied: a kill's window closed. */
  readonly found: number;
  /** When a driver started again after each kill. */
  readonly restarts: readonly Date[];
  /** What the drivers reported, in order. */
  readonly notices: readonly DriverNotice[];
  close(): void;
}

/** A process of a driver: its life and the driver itself. */
interface Process {
  life: Life;
  driver: Driver;
}

export const openChaosEngine = async (
  path: string,
  plays: (attempt: AttemptRef) => Play,
  plan: KillPlan,
  host: FakeCodeHost,
): Promise<ChaosEngine> => {
  // A run on another run's database would not start from scratch.
  if (existsSync(path)) throw new Error(`A chaos run needs a database of its own: ${path} exists`);
  const kill = killer(plan);
  const locks = fakeLocks();
  let now = t0;
  const restarts: Date[] = [];
  const notices: DriverNotice[] = [];
  // One connection for the whole run, which every driver process sees through its life. One
  // thread runs each transaction to its end before the next begins, so a connection per process
  // would show the same committed events and cost only page cache reloads. The terminal and the
  // checks use it as it is: they are never killed.
  const outside = openSqliteEventStore(path, { openDatabase });
  const terminal: CommandLog = createCommandLog({ store: outside, recipes, reminderMs, routingMs });
  const owner = 'cellar';

  /** Starts a new process of the driver, until one survives its start, drive and effects. */
  const boot = async (): Promise<Process> => {
    for (;;) {
      const life = kill.life(owner);
      try {
        const driver = await openDriver({
          store: killableStore(outside, life),
          runner: fakeBrewerRunner(({ ref }) => behaviourOf(plays(ref), now)),
          recipes,
          clock: () => now,
          lock: () => locks.take(life),
          takes: () => true,
          stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
          limits: () => ({ ...defaultLimits, ...scenarioLimits }),
          effects: {
            due: (state, batchId) => {
              const batch = state.batches.get(batchId);
              return batch === undefined ? [] : batchEffectsDue(batch);
            },
            target: host.target(life),
          },
          reminderMs,
          routingMs,
          report: (notice) => notices.push(notice),
        });
        // A new driver takes over its leases, starts the attempts that were scheduled and applies
        // the effects due.
        await driver.drive();
        await driver.applyEffects();
        if (!life.dead) return { life, driver };
      } catch (error) {
        if (!(error instanceof EngineKilled)) throw error;
      }
      restarts.push(now);
    }
  };
  let current = await boot();

  /** Runs `fn` on the driver; true when it survived, else restarts it until it is up again. */
  const surviving = async (fn: (driver: Driver) => Promise<void>): Promise<boolean> => {
    try {
      await fn(current.driver);
    } catch (error) {
      if (!(error instanceof EngineKilled)) throw error;
    }
    // A kill the driver caught and reported (a failed effect, a failed tick) still killed it.
    if (!current.life.dead) return true;
    restarts.push(now);
    current = await boot();
    return false;
  };

  const play = async (move: Move): Promise<boolean> => {
    kill.moved();
    switch (move.kind) {
      case 'command':
        // A command from the terminal, beside the driver; the driver drives on what it decided.
        terminal.issue(move.command, now);
        return surviving(async (driver) => {
          await driver.drive();
          await driver.applyEffects();
        });
      case 'tick':
        now = new Date(now.getTime() + move.advanceMs);
        return surviving((driver) => driver.tick());
      default: {
        const unhandled: never = move;
        throw new Error(`Unhandled move ${JSON.stringify(unhandled)}`);
      }
    }
  };

  return {
    now: () => now,
    state: terminal.state,
    store: () => outside,
    events: () => outside.eventsAfter(0).map(({ event }) => event),
    play,
    applyEffects: async () => {
      await surviving((driver) => driver.applyEffects());
    },
    kills: kill.kills,
    restarts,
    notices,
    get found() {
      return host.found;
    },
    close: () => {
      if (!current.life.dead) current.driver.close();
      outside.close();
    },
  };
};

/** What a chaos run did, for its checks and for a report. */
export interface ChaosRun {
  readonly engine: ChaosEngine;
  readonly host: FakeCodeHost;
  readonly scenario: Scenario;
  /** Every move played, the generated ones and the ticks that let the batches come to rest. */
  readonly moves: Move[];
}

/** Checks of a chaos run; each throws when what it checks is broken. */
export interface ChaosChecks {
  /** After every move, with whether the driver lived through it. */
  afterMove?(run: ChaosRun, move: Move, survived: boolean): void;
  /** Once every batch is at rest and the effects due are applied. */
  atEnd?(run: ChaosRun): void;
}

/** How far the clock moves on per tick once the scenario is over, and for at most how many ticks. */
const settleMs = 30 * 60_000;
const maxSettleTicks = 100;

const brewing = (state: State): string[] =>
  [...state.batches.values()].filter((b) => b.lane.kind === 'brewing').map((b) => b.id);

/**
 * Plays `source` with `plan`'s kills, then ticks until no batch is brewing and the last tick was
 * one the driver lived through, then applies the effects that are due, checking `checks` along
 * the way.
 */
export const runChaos = async (
  run: ChaosRun,
  source: MoveSource,
  checks: ChaosChecks = {},
): Promise<void> => {
  const { engine } = run;
  const step = async (move: Move): Promise<boolean> => {
    run.moves.push(move);
    const survived = await engine.play(move);
    checks.afterMove?.(run, move, survived);
    return survived;
  };
  for (let move = source.move(engine.state()); move !== undefined; ) {
    await step(move);
    move = source.move(engine.state());
  }
  // Until no batch is brewing, and at least once: the driver's last tick must be one it lived
  // through, or a deadline that came due before a kill would never be seen.
  let ticked = false;
  for (let ticks = 0; !ticked || brewing(engine.state()).length > 0; ticks++) {
    if (ticks === maxSettleTicks) {
      throw new Error(
        `Batches still brewing after ${maxSettleTicks} ticks of ${settleMs / 60_000} min: ` +
          brewing(engine.state()).join(', '),
      );
    }
    ticked = await step({ kind: 'tick', advanceMs: settleMs });
  }
  // A kill may have ended the last pass before an effect was recorded.
  await engine.applyEffects();
  checks.atEnd?.(run);
};

/** Seeds per chaos property in npm run check, where the chaos layer has a time ceiling. */
const chaosRuns = 5;

/**
 * Runs the generated scenario of each seed with that seed's kill plan, on a database in `dir`, and
 * checks `checks`. A failure names the seed and shows the kills, the moves and the events.
 */
export const holdsAcrossKills = (dir: string, checks: ChaosChecks): Promise<void> =>
  forEachSeedAsync(chaosRuns, async (seed) => {
    // A folder per seed: the database, its -wal and -shm files go together.
    const folder = join(dir, `seed-${seed}`);
    mkdirSync(folder);
    const path = join(folder, 'events.sqlite');
    const scenario: Scenario = { moves: [], plays: [] };
    const source = recording(generateScenario(seed), scenario);
    const host = fakeCodeHost();
    let engine: ChaosEngine | undefined;
    const moves: Move[] = [];
    try {
      engine = await openChaosEngine(path, (attempt) => source.play(attempt), killPlan(seed), host);
      await runChaos({ engine, host, scenario, moves }, source, checks);
    } catch (error) {
      throw noted(error, engine === undefined ? '' : report({ engine, host, scenario, moves }));
    } finally {
      engine?.close();
      // With retries for files Windows still holds; what is left goes with `dir`, and a failed
      // removal never hides the run's own error.
      await removeTree(folder).catch(() => {});
    }
  });

/** The kills, moves, plays and events of `run`, numbered. */
const report = ({ engine, scenario, moves }: ChaosRun): string => {
  const numbered = (lines: readonly string[]): string =>
    lines.length === 0
      ? '    (none)'
      : lines.map((line, i) => `  ${String(i + 1).padStart(3)}. ${line}`).join('\n');
  let events: string[];
  try {
    events = engine.events().map(describeEvent);
  } catch (error) {
    events = [`(cannot read the events: ${String(error)})`];
  }
  return [
    'Kills (counted in kill points from the start of the run):',
    numbered(
      engine.kills.map(
        ({ at, point, move, driver }) => `#${at} ${driver} ${point}, in move ${move}`,
      ),
    ),
    'Moves:',
    numbered(
      moves.map((move) =>
        move.kind === 'command'
          ? describeCommand(move.command)
          : `tick +${move.advanceMs / 60_000} min`,
      ),
    ),
    'Plays, by attempt, in the order they started:',
    numbered(scenario.plays.map(describePlay)),
    'Events:',
    numbered(events),
  ].join('\n');
};
