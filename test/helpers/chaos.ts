// The chaos harness (#15, architecture §9): engine scenarios (test/helpers/simulation.ts) on an
// event store in a file, with the engine killed at random points of its run's seed, inside
// transactions and between them, and restarted on the same file (ADR 0032). A kill ends
// everything that lived in the engine's memory:
// the driver, the supervisor, the fake runner and every attempt it ran. What survives is the
// database and the code host the effects went to. No process is started or killed: the engine is
// this test's own code, and a kill is an exception it cannot catch.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { applyEffect, type EffectTarget, type Ledger } from '../../src/engine/effects.ts';
import type { EffectKey, EventStore, EventStoreTransaction } from '../../src/engine/event-store.ts';
import type { State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { createBrewing, defaultLimits } from './brewing.ts';
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
import { behaviourOf, recipes, reminderMs, t0 } from './simulation.ts';

export const killPoints = [
  'in a transaction',
  'after a commit',
  'before an effect reached its target',
  'after an effect reached its target',
] as const;
export type KillPoint = (typeof killPoints)[number];

/** Thrown at a kill point, and by everything the dead engine touches afterwards. */
export class EngineKilled extends Error {
  constructor(point: KillPoint | 'dead') {
    super(point === 'dead' ? 'The engine is dead' : `The engine was killed ${point}`);
    this.name = 'EngineKilled';
  }
}

/** A kill as it happened: at which point, and during which move (0 before the first). */
export interface Kill {
  /** The number of the kill point, counted from the start of the run across restarts. */
  at: number;
  point: KillPoint;
  move: number;
}

/**
 * When to kill the engine: at each kill point it dies with the chance of that kind of point, drawn
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

/** Counts kill points and kills the engine at the planned ones. */
const killer = (plan: KillPlan) => {
  const random = seededRandom(plan.seed ^ 0x5eed_c4a0);
  let passed = 0;
  let dead = false;
  const kills: Kill[] = [];
  let move = 0;
  return {
    kills,
    /** Passes a kill point; throws when the engine dies here or is already dead. */
    point: (point: KillPoint): void => {
      if (dead) throw new EngineKilled('dead');
      passed++;
      if (kills.length === plan.maxKills || !random.chance(plan.chance[point])) return;
      dead = true;
      kills.push({ at: passed, point, move });
      throw new EngineKilled(point);
    },
    /** Throws when the engine is dead. */
    alive: (): void => {
      if (dead) throw new EngineKilled('dead');
    },
    isDead: (): boolean => dead,
    restart: (): void => {
      dead = false;
    },
    moved: (): void => {
      move++;
    },
  };
};
type Killer = ReturnType<typeof killer>;

/**
 * `inner` with a kill point before every write in a transaction and after every commit. A kill in
 * a transaction throws inside it, so the store rolls it back: what a database shows after its
 * process died with a transaction open.
 */
const killableStore = (inner: EventStore, kill: Killer): EventStore => {
  const writes = (tx: EventStoreTransaction): EventStoreTransaction => ({
    append: (event) => {
      kill.point('in a transaction');
      return tx.append(event);
    },
    putLease: (lease) => {
      kill.point('in a transaction');
      tx.putLease(lease);
    },
    releaseLease: (key) => {
      kill.point('in a transaction');
      tx.releaseLease(key);
    },
    recordEffect: (key, result) => {
      kill.point('in a transaction');
      tx.recordEffect(key, result);
    },
    markPushed: (marker) => {
      kill.point('in a transaction');
      tx.markPushed(marker);
    },
  });
  const read =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      kill.alive();
      return fn(...args);
    };
  return {
    withTransaction: (fn) => {
      kill.alive();
      const result = inner.withTransaction((tx) => fn(writes(tx)));
      kill.point('after a commit');
      return result;
    },
    eventsAfter: read(inner.eventsAfter),
    batchesPastDeadline: read(inner.batchesPastDeadline),
    currentLeases: read(inner.currentLeases),
    expiredLeases: read(inner.expiredLeases),
    replay: read(inner.replay),
    lastEventId: read(inner.lastEventId),
    pushedThrough: read(inner.pushedThrough),
    restore: read(inner.restore),
    findEffect: read(inner.findEffect),
    close: () => inner.close(),
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
  const target = (kill: Killer): EffectTarget => ({
    find: async (key) => {
      kill.alive();
      const [first] = applied.get(key) ?? [];
      return first === undefined ? undefined : { result: first };
    },
    apply: async (key) => {
      kill.point('before an effect reached its target');
      const result = { comment: ++comments };
      applied.set(key, [...(applied.get(key) ?? []), result]);
      // The comment exists; the engine dies before it hears so.
      kill.point('after an effect reached its target');
      return result;
    },
  });
  return { applied, target };
};

/** The effect each succeeded attempt has: a comment on its issue, keyed by the attempt. */
export const progressComment = 'progress_comment';

/** The effects `state` calls for: one per succeeded attempt. */
export const effectsDue = (state: State): EffectKey[] =>
  [...state.batches.values()].flatMap((batch) =>
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
    ),
  );

// A kill ends the process, not the machine: what SQLite handed the OS survives it whatever
// `synchronous` says, so the harness skips the fsyncs that would only guard against power loss.
const openDatabase = (file: string, options: ConstructorParameters<typeof DatabaseSync>[1]) => {
  const db = new DatabaseSync(file, options);
  db.exec('PRAGMA synchronous = OFF');
  return db;
};

/** The engine of a chaos run: a fresh one starts on the same database after every kill. */
export interface ChaosEngine {
  now(): Date;
  state(): State;
  store(): EventStore;
  events(): Event[];
  /** Plays one move; a kill during it restarts the engine. False when the engine died in it. */
  play(move: Move): Promise<boolean>;
  /** Applies the effects the state calls for and that are not in the ledger. */
  applyEffects(): Promise<void>;
  readonly kills: readonly Kill[];
  /** How often an effect was found on the code host rather than applied: a kill's window closed. */
  readonly found: number;
  /** When the engine started again after each kill. */
  readonly restarts: readonly Date[];
  close(): void;
}

export const openChaosEngine = (
  path: string,
  plays: (attempt: AttemptRef) => Play,
  plan: KillPlan,
  host: ReturnType<typeof fakeCodeHost>,
): ChaosEngine => {
  // A run on another run's database would not start from scratch.
  if (existsSync(path)) throw new Error(`A chaos run needs a database of its own: ${path} exists`);
  const kill = killer(plan);
  let now = t0;
  let found = 0;
  const restarts: Date[] = [];

  const boot = () => {
    const inner = openSqliteEventStore(path, { openDatabase });
    const store = killableStore(inner, kill);
    const runner = fakeBrewerRunner(({ ref }) => behaviourOf(plays(ref), now));
    const brewing = createBrewing({
      store,
      runner,
      recipes,
      clock: () => now,
      limits: () => ({ ...defaultLimits, ...scenarioLimits }),
      reminderMs,
    });
    return { inner, store, brewing };
  };
  let engine = boot();

  const applyEffects = async (): Promise<void> => {
    const { brewing, store } = engine;
    const ledger: Ledger = {
      find: (key) => store.findEffect(key),
      record: (key, result) => {
        const event = { type: 'effect.applied', key: effectKey.encode(key), result } as const;
        if (!brewing.command({ kind: 'record', event })) {
          throw new Error(`The ledger refused ${event.key}: ${brewing.refusals.at(-1)}`);
        }
      },
    };
    for (const key of effectsDue(brewing.state())) {
      const { via } = await applyEffect(ledger, key, host.target(kill));
      if (via === 'found') found++;
    }
  };

  /** Runs `fn`; true when the engine survived it, else restarts it until it is up again. */
  const surviving = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof EngineKilled)) throw error;
    }
    // A kill the supervisor caught and reported still killed the engine.
    if (!kill.isDead()) return true;
    while (kill.isDead()) {
      engine.inner.close();
      kill.restart();
      restarts.push(now);
      engine = boot();
      // A new engine takes over the leases, starts the attempts that were scheduled and applies
      // the effects due.
      try {
        engine.brewing.start();
        await engine.brewing.drive();
        await applyEffects();
      } catch (error) {
        if (!(error instanceof EngineKilled)) throw error;
      }
    }
    return false;
  };

  const play = async (move: Move): Promise<boolean> => {
    kill.moved();
    return surviving(async () => {
      switch (move.kind) {
        case 'command':
          engine.brewing.command(move.command);
          await engine.brewing.drive();
          break;
        case 'tick':
          now = new Date(now.getTime() + move.advanceMs);
          await engine.brewing.tick();
          break;
        default: {
          const unhandled: never = move;
          throw new Error(`Unhandled move ${JSON.stringify(unhandled)}`);
        }
      }
      await applyEffects();
    });
  };

  return {
    now: () => now,
    state: () => engine.brewing.state(),
    store: () => engine.store,
    events: () => engine.brewing.events(),
    play,
    applyEffects: async () => {
      await surviving(applyEffects);
    },
    kills: kill.kills,
    restarts,
    get found() {
      return found;
    },
    close: () => engine.inner.close(),
  };
};

/** What a chaos run did, for its checks and for a report. */
export interface ChaosRun {
  readonly engine: ChaosEngine;
  readonly host: ReturnType<typeof fakeCodeHost>;
  readonly scenario: Scenario;
  /** Every move played, the generated ones and the ticks that let the batches come to rest. */
  readonly moves: Move[];
}

/** Checks of a chaos run; each throws when what it checks is broken. */
export interface ChaosChecks {
  /** After every move, with whether the engine lived through it. */
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
 * Plays `source` with `plan`'s kills, then ticks until no batch is brewing and applies the effects
 * that are due, checking `checks` along the way.
 */
export const runChaos = async (
  run: ChaosRun,
  source: MoveSource,
  checks: ChaosChecks = {},
): Promise<void> => {
  const { engine } = run;
  const step = async (move: Move): Promise<void> => {
    run.moves.push(move);
    const survived = await engine.play(move);
    checks.afterMove?.(run, move, survived);
  };
  for (let move = source.move(engine.state()); move !== undefined; ) {
    await step(move);
    move = source.move(engine.state());
  }
  for (let ticks = 0; brewing(engine.state()).length > 0; ticks++) {
    if (ticks === maxSettleTicks) {
      throw new Error(
        `Batches still brewing after ${maxSettleTicks} ticks of ${settleMs / 60_000} min: ` +
          brewing(engine.state()).join(', '),
      );
    }
    await step({ kind: 'tick', advanceMs: settleMs });
  }
  // A kill may have ended the last pass before an effect was recorded.
  await engine.applyEffects();
  checks.atEnd?.(run);
};

/** Seeds per chaos property in npm run check, where the chaos layer has a time ceiling. */
const chaosRuns = 15;

/**
 * Runs the generated scenario of each seed with that seed's kill plan, on a database in `dir`, and
 * checks `checks`. A failure names the seed and shows the kills, the moves and the events.
 */
export const holdsAcrossKills = (dir: string, checks: ChaosChecks): Promise<void> =>
  forEachSeedAsync(chaosRuns, async (seed) => {
    const path = join(dir, `seed-${seed}.sqlite`);
    const scenario: Scenario = { moves: [], plays: [] };
    const source = recording(generateScenario(seed), scenario);
    const host = fakeCodeHost();
    const engine = openChaosEngine(path, (attempt) => source.play(attempt), killPlan(seed), host);
    const run: ChaosRun = { engine, host, scenario, moves: [] };
    try {
      await runChaos(run, source, checks);
    } catch (error) {
      throw noted(error, report(run));
    } finally {
      engine.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
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
    numbered(engine.kills.map(({ at, point, move }) => `#${at} ${point}, in move ${move}`)),
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
