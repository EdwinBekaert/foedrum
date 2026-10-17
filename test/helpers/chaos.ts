// The chaos harness (#15, architecture §9): engine scenarios (test/helpers/simulation.ts) played
// against the real driver (`openDriver`, ADR 0044) on an event store in a file, with the driver
// killed at random points of its run's seed, inside transactions and between them, and restarted
// on the same file (ADR 0033). A kill ends everything that lived in the driver's memory: the
// driver, its supervisor, its fake runner and every attempt it ran, and its lock, which the
// operating system releases (ADR 0037). What survives is the database and the code host the
// effects went to. No process is started or killed: the driver is this test's own code, and a
// kill is an exception it cannot catch.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Command, EngineCommand } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { type DriverLock, DriverRunningError } from '../../src/engine/driver-lock.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EffectTarget } from '../../src/engine/effects.ts';
import type {
  BatchLease,
  EffectKey,
  EventStore,
  EventStoreTransaction,
  StoredEvent,
} from '../../src/engine/event-store.ts';
import type { Batch, State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from './brewing.ts';
import {
  type FakeStateBranch,
  fakeStateBranch,
  type StateBranchKillPoint,
} from './chaos-state-branch.ts';
import { chaosRepo, type FakeClone, fakeClone, type WorktreeKillPoint } from './chaos-worktrees.ts';
import {
  human,
  type Move,
  type MoveSource,
  type Play,
  type Scenario,
  scenarioLimits,
  seededRandom,
} from './event-sequences.ts';
import { fakeBrewerRunner } from './fake-brewer-runner.ts';
import { behaviourOf, isLive, recipes, reminderMs, routingMs, t0 } from './simulation.ts';

export const killPoints = [
  'in a transaction',
  'after a commit',
  'before an effect reached its target',
  'after an effect reached its target',
] as const;
/** Every kill point: the ones above, and those of the worktree and state branch models. */
export type KillPoint = (typeof killPoints)[number] | WorktreeKillPoint | StateBranchKillPoint;

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
  /** The move's number in the run as first played (`Fault.move`). */
  move: number;
  /** The owner of the driver that died. */
  driver: string;
}

/** What a terminal command issued between a driver's read and its append does. */
export interface Interjected {
  kind: 'retry' | 'skip' | 'cancel';
  batchId: string;
}

/** A kind of decision the faults of a run make. */
export type FaultKind = `kill ${KillPoint}` | 'pause' | 'first' | 'down' | 'stall' | 'interject';

/**
 * A fault a run had: a decision other than the quiet one (no kill, no pause, no stall, …), at a
 * site that removing another move leaves where it is. A site is the move, by its number in the
 * run as first played, the driver, and how many decisions of that kind for that driver came
 * before it in that move. A count over the whole run would move every later fault when a move
 * goes, and a run shrunk that way keeps none of the faults it failed by (#150).
 */
export interface Fault {
  /** 0 before the first move. */
  move: number;
  /** The driver it happened to; empty for the order the drivers start a move in. */
  driver: string;
  kind: FaultKind;
  n: number;
  /** 1 for a kill; turns of the event loop, the first driver, or moves; or the command. */
  value: number | Interjected;
}

/** The decisions of a run's faults, each at its site (`Fault`). */
export interface Faults {
  /** The move that is played now, by its number in the run as first played. */
  at(move: number): void;
  /** Whether `driver` dies at this kill point, with `kills` kills in the run so far. */
  kill(driver: string, point: KillPoint, kills: number): boolean;
  /** How many turns of the event loop a call to the code host lets the other drivers run. */
  pause(driver: string): number;
  /** Which of `drivers` drivers plays the move first. */
  first(drivers: number): number;
  /** For how many moves a killed driver stays down: 0 starts it again at once. */
  down(driver: string): number;
  /** For how many moves a live driver stalls now: 0 for none. `busy`: its brewers run. */
  stall(driver: string, busy: boolean): number;
  /** The command the terminal issues as `driver` begins a transaction, on one of `live`. */
  interject(driver: string, live: () => string[]): Interjected | undefined;
  /** The faults decided so far, in order. */
  readonly made: readonly Fault[];
}

const siteKey = ({ move, driver, kind, n }: Omit<Fault, 'value'>): string =>
  `${move} ${driver} ${kind} ${n}`;

/** Numbers the decisions of each kind for each driver within the move played now. */
const sites = () => {
  let move = 0;
  const counts = new Map<string, number>();
  return {
    at: (next: number): void => {
      move = next;
      counts.clear();
    },
    next: (driver: string, kind: FaultKind): Omit<Fault, 'value'> => {
      const key = `${driver} ${kind}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      return { move, driver, kind, n };
    },
  };
};

/**
 * The faults `plan` draws from random streams of its seed: kills at each kill point and, with
 * several drivers, the order they play a move in, pauses at the code host, drivers that stay down
 * after a kill or stall, and terminal commands mid-tick (ADR 0051).
 */
export const drawnFaults = (plan: KillPlan, several: boolean): Faults => {
  const killing = seededRandom(plan.seed ^ 0x5eed_c4a0);
  // With several drivers, each call to the code host lets the others run for a few turns of the
  // event loop, so their passes interleave.
  const interleaving = several ? seededRandom(plan.seed ^ 0x1e_a5ed) : undefined;
  // A killed driver stays down for a few moves now and then, so the other takes its batches over
  // once their leases expired, while its brewers may still run (ADR 0044).
  const downtime = several ? seededRandom(plan.seed ^ 0xd0_3e) : undefined;
  // A live driver stalls for a few moves now and then, more often while its brewers run: its
  // leases expire, the other takes its batch, and it finds that out when it goes on (ADR 0044).
  const stalling = several ? seededRandom(plan.seed ^ 0x57_a11) : undefined;
  // The terminal now and then issues a human command on a live batch as a driver begins a
  // transaction: after it read the events and before it appends (ADR 0044).
  const interjecting = several ? seededRandom(plan.seed ^ 0x7e_a1) : undefined;
  const site = sites();
  const made: Fault[] = [];
  const note = <T extends number | Interjected | undefined>(
    driver: string,
    kind: FaultKind,
    value: T,
  ): T => {
    const at = site.next(driver, kind);
    if (value !== undefined && value !== 0) made.push({ ...at, value });
    return value;
  };
  return {
    at: site.at,
    kill: (driver, point, kills) =>
      note(
        driver,
        `kill ${point}`,
        kills < plan.maxKills && killing.chance(plan.chance[point]) ? 1 : 0,
      ) === 1,
    pause: (driver) => note(driver, 'pause', interleaving?.int(3) ?? 0),
    first: (drivers) => note('', 'first', interleaving?.int(drivers) ?? 0),
    down: (driver) => note(driver, 'down', downtime?.chance(0.5) ? 1 + downtime.int(3) : 0),
    stall: (driver, busy) =>
      note(driver, 'stall', stalling?.chance(busy ? 0.2 : 0.02) ? 1 + stalling.int(3) : 0),
    interject: (driver, live) => {
      let command: Interjected | undefined;
      if (interjecting?.chance(0.02)) {
        const ids = live();
        if (ids.length > 0) {
          const batchId = interjecting.pick(ids);
          const kind = interjecting.chance(0.2)
            ? 'cancel'
            : interjecting.pick(['retry', 'skip'] as const);
          command = { kind, batchId };
        }
      }
      return note(driver, 'interject', command);
    },
    made,
  };
};

/**
 * Exactly `faults`, each at its site, and the quiet decision everywhere else. `made` holds the
 * ones the run reached: a site a shorter run never gets to has no fault.
 */
export const replayedFaults = (faults: readonly Fault[]): Faults => {
  const bySite = new Map(faults.map((fault) => [siteKey(fault), fault]));
  const site = sites();
  const made: Fault[] = [];
  const get = (driver: string, kind: FaultKind): Fault['value'] | undefined => {
    const fault = bySite.get(siteKey(site.next(driver, kind)));
    if (fault !== undefined) made.push(fault);
    return fault?.value;
  };
  const count = (value: Fault['value'] | undefined): number =>
    typeof value === 'number' ? value : 0;
  return {
    at: site.at,
    kill: (driver, point) => get(driver, `kill ${point}`) === 1,
    pause: (driver) => count(get(driver, 'pause')),
    first: () => count(get('', 'first')),
    down: (driver) => count(get(driver, 'down')),
    stall: (driver) => count(get(driver, 'stall')),
    interject: (driver) => {
      const value = get(driver, 'interject');
      return typeof value === 'object' ? value : undefined;
    },
    made,
  };
};

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
    // A few points per attempt, and per cleanup of an ended batch.
    'while making a worktree': 0.05,
    'after a worktree was made': 0.05,
    'while cleaning worktrees': 0.05,
    // A flush at every tick with events to push, a file per batch they belong to.
    'while writing the log': 0.02,
    'before the push reached the remote': 0.03,
    'after the push reached the remote': 0.03,
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

/** Counts kill points across every driver of a run and kills a driver where `faults` say. */
const killer = (faults: Faults) => {
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
        if (!faults.kill(driver, point, kills.length)) return;
        dead = true;
        kills.push({ at: passed, point, move, driver });
        throw new EngineKilled(point);
      },
    };
  };
  return {
    kills,
    life,
    moved: (site: number): void => {
      move = site;
      faults.at(site);
    },
  };
};

/** What the harness watches in a driver's store. */
interface StoreWatch {
  /** A batch lease the driver read in a transaction. */
  read(lease: BatchLease | undefined): void;
  /** Called as the driver begins a transaction, after it read what it decides on. */
  beginning(): void;
}

/**
 * The store as the driver of `life` sees it: `inner` with a kill point before every write in a
 * transaction and after every commit. A kill in a transaction throws inside it, so the store rolls
 * it back: what a database shows after its process died with a transaction open.
 */
const killableStore = (inner: EventStore, life: Life, watch: StoreWatch): EventStore => {
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
      const lease = tx.batchLease(batchId);
      watch.read(lease);
      return lease;
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
  const reading =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      life.alive();
      return fn(...args);
    };
  return {
    withTransaction: (fn) => {
      life.alive();
      watch.beginning();
      const result = inner.withTransaction((tx) => fn(writes(tx)));
      life.point('after a commit');
      return result;
    },
    eventsAfter: reading(inner.eventsAfter),
    batchesPastDeadline: reading(inner.batchesPastDeadline),
    currentLeases: reading(inner.currentLeases),
    expiredLeases: reading(inner.expiredLeases),
    batchLeases: reading(inner.batchLeases),
    replay: reading(inner.replay),
    lastEventId: reading(inner.lastEventId),
    pushedThrough: reading(inner.pushedThrough),
    restore: reading(inner.restore),
    findEffect: reading(inner.findEffect),
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

/** The batch an engine command is about, if any. */
const batchOf = (command: EngineCommand): string | undefined =>
  command.kind !== 'record'
    ? command.batchId
    : 'batchId' in command.event
      ? command.event.batchId
      : undefined;

/** How a driver's calls reach the code host. */
export interface HostCall {
  /** Lets the other drivers run before the call goes on, as a request over the network would. */
  pause(): Promise<void>;
  /** Called as the effect of `key` is applied. */
  applying(key: string): void;
}

const direct: HostCall = { pause: async () => {}, applying: () => {} };

/**
 * The code host the effects land on. Like GitHub, it applies what it is asked to as often as it
 * is asked, and finds an effect by the key it carries (a marker in a comment's body).
 */
export const fakeCodeHost = () => {
  /** Every result applied, by effect key, in order. */
  const applied = new Map<string, unknown[]>();
  /** Calls of `applyEffect` for one key that overlapped: two live drivers between find and apply. */
  const overlaps: string[] = [];
  // The driver that found nothing for a key and has not applied it yet.
  const finding = new Map<string, Life>();
  let comments = 0;
  let found = 0;
  const target = (life: Life, call: HostCall = direct): EffectTarget => {
    const overlapping = (key: string): void => {
      const other = finding.get(key);
      if (other !== undefined && other !== life && !other.dead) {
        overlaps.push(`${key}: ${other.driver} and ${life.driver}`);
      }
    };
    return {
      find: async (key) => {
        life.alive();
        await call.pause();
        life.alive();
        overlapping(key);
        const [first] = applied.get(key) ?? [];
        if (first === undefined) {
          finding.set(key, life);
          return undefined;
        }
        found++;
        return { result: first };
      },
      apply: async (key) => {
        life.point('before an effect reached its target');
        await call.pause();
        life.alive();
        overlapping(key);
        call.applying(key);
        const result = { comment: ++comments };
        applied.set(key, [...(applied.get(key) ?? []), result]);
        if (finding.get(key) === life) finding.delete(key);
        // The comment exists; the driver dies before it hears so.
        life.point('after an effect reached its target');
        return result;
      },
    };
  };
  return {
    applied,
    overlaps,
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

/** An attempt a driver started, or an effect it applied, and whether it held the batch then. */
export interface Act {
  driver: string;
  kind: 'start' | 'apply';
  /** The attempt key, or the effect key. */
  key: string;
  batchId: string;
  /** Whether the store showed the driver's live lease of the batch at that moment. */
  held: boolean;
}

/** A driver that read another driver's live lease of a batch it wanted. */
export interface Contest {
  driver: string;
  batchId: string;
  holder: string;
}

/** A batch a driver took over from one that was down: its lease had expired. */
export interface Takeover {
  driver: string;
  batchId: string;
  from: string;
  /** Why the driver it took the batch from was down. */
  why: 'killed' | 'stalled';
}

/**
 * A driver that did not run from a move until the one it ran again in: killed and not yet started
 * again, or stalled, alive with its brewers running but doing nothing itself, as a paused process.
 */
export interface Down {
  driver: string;
  why: 'killed' | 'stalled';
  from: number;
  until: number;
}

/** A driver that found another's live lease on a batch it held, with the attempts it ran there. */
export interface Loss {
  driver: string;
  batchId: string;
  /** The attempt keys its runner still ran in the batch. */
  running: string[];
}

/** A command the terminal issued as a driver began a transaction: between its read and its append. */
export interface Interjection {
  move: number;
  /** The driver whose transaction it came before. */
  driver: string;
  batchId: string;
  command: Command;
  accepted: boolean;
}

/** A driver that started again under its owner, with the batches it held then. */
export interface Resume {
  driver: string;
  /** The batches whose live lease its owner had as it started. */
  leased: string[];
  /** The batches the new driver holds once started. */
  held: string[];
  /** How many acts there were before it: the ones after are its own and the others'. */
  actsBefore: number;
}

export interface ChaosOptions {
  /** The owners of the drivers on the store; default one, `cellar`. Each takes every batch. */
  drivers?: readonly string[];
  /** Exactly these faults, instead of the ones the kill plan draws: a run replayed, or shrunk. */
  faults?: readonly Fault[];
  /** Gives the drivers attempt worktrees in an in-memory clone (`fakeClone`), with its kill points. */
  worktrees?: boolean;
  /**
   * Gives the drivers an in-memory state branch (`fakeStateBranch`), with its kill points: each
   * process starts on it before it opens its driver, and its supervisor flushes it.
   */
  stateBranch?: boolean;
  /** The moves a seed's run plays (`trialChaos`); default its generated scenario. */
  moves?: (seed: number) => MoveSource;
}

/**
 * `inner` with its committed events read and parsed once: every command log of a run (each
 * driver's, each supervisor's, the terminal's) reads the same ones on the run's one connection.
 * The cache catches up after a transaction that appended, committed or rolled back; a read inside
 * one goes to `inner`, so an append that a kill rolls back is never cached.
 */
const withEventCache = (inner: EventStore): EventStore => {
  const cached: StoredEvent[] = [];
  let behind = true;
  let inTransaction = false;
  return {
    ...inner,
    withTransaction: (fn) => {
      inTransaction = true;
      try {
        return inner.withTransaction((tx) =>
          fn({
            ...tx,
            append: (event) => {
              behind = true;
              return tx.append(event);
            },
          }),
        );
      } finally {
        inTransaction = false;
      }
    },
    eventsAfter: (afterId, limit) => {
      if (inTransaction || limit !== undefined) return inner.eventsAfter(afterId, limit);
      if (behind) {
        cached.push(...inner.eventsAfter(cached.at(-1)?.id ?? 0));
        behind = false;
      }
      const from = cached.findIndex((stored) => stored.id > afterId);
      return from === -1 ? [] : cached.slice(from);
    },
  };
};

/** The drivers of a chaos run: a fresh process of a driver starts on the same database after every kill. */
export interface ChaosEngine {
  now(): Date;
  /** The folded state of every committed event. */
  state(): State;
  /** The store as a process beside the drivers sees it; never killed. */
  store(): EventStore;
  events(): Event[];
  /**
   * Plays one move, the one numbered `site` in the run as first played (by default the next
   * number); a driver killed during it starts again, at once or, with several drivers, some
   * moves later. False when a driver that ran in it died.
   */
  play(move: Move, site?: number): Promise<boolean>;
  /** The faults the run had so far, at their sites, in order. */
  readonly faults: readonly Fault[];
  /** The drivers that did not run in the last move: down after a kill, or stalled. */
  idle(): readonly string[];
  /** Applies the effects that are due and not in the ledger. */
  applyEffects(): Promise<void>;
  readonly kills: readonly Kill[];
  /** How often an effect was found on the code host rather than applied: a kill's window closed. */
  readonly found: number;
  /** When a driver started again after each kill. */
  readonly restarts: readonly Date[];
  /** Every attempt the drivers started and every effect they applied, in order. */
  readonly acts: readonly Act[];
  /** Every time a driver found another's live lease on a batch it wanted. */
  readonly contests: readonly Contest[];
  /** Every batch a driver took over from one that was down. */
  readonly takeovers: readonly Takeover[];
  /** Every time a driver stayed down after a kill, or stalled. */
  readonly downs: readonly Down[];
  /** Every batch a driver lost to another. */
  readonly losses: readonly Loss[];
  /** The attempts whose runs a driver stopped, by attempt key, with the driver. */
  readonly stops: readonly { driver: string; key: string }[];
  /** Every command the terminal issued between a driver's read and its append. */
  readonly interjections: readonly Interjection[];
  /** The commands of drivers that were refused in a move with an interjection before them. */
  readonly moot: readonly { driver: string; command: EngineCommand; reason: string }[];
  /** Every start of a driver after its first, under the same owner. */
  readonly resumes: readonly Resume[];
  /** The clone the attempt worktrees are in, when the run has one. */
  readonly clone: FakeClone | undefined;
  /** The state branch, when the run has one. */
  readonly branch: FakeStateBranch | undefined;
  close(): void;
}

/** A process of a driver: its life, the driver itself, and the attempts its runner runs. */
interface Process {
  life: Life;
  driver: Driver;
  running: ReadonlyMap<string, AttemptRef>;
}

export const openChaosEngine = async (
  path: string,
  plays: (attempt: AttemptRef) => Play,
  plan: KillPlan,
  host: FakeCodeHost,
  options: ChaosOptions = {},
): Promise<ChaosEngine> => {
  const { drivers = ['cellar'] } = options;
  // A run on another run's database would not start from scratch.
  if (existsSync(path)) throw new Error(`A chaos run needs a database of its own: ${path} exists`);
  const faults =
    options.faults === undefined
      ? drawnFaults(plan, drivers.length > 1)
      : replayedFaults(options.faults);
  const kill = killer(faults);
  const locks = fakeLocks();
  // Every runner a driver process had, with its life: a dead one's attempts died with it, and so
  // did a lost one's, which its runner reports no progress of.
  const runners: { life: Life; runs: (key: string) => boolean }[] = [];
  const clone =
    options.worktrees === true
      ? fakeClone({
          running: (key) => runners.some(({ life, runs }) => !life.dead && runs(key)),
          state: () => terminal.state(),
        })
      : undefined;
  const branch =
    options.stateBranch === true ? fakeStateBranch(() => kill.kills.at(-1)?.point) : undefined;
  let now = t0;
  const restarts: Date[] = [];
  const losses: Loss[] = [];
  const stops: { driver: string; key: string }[] = [];
  const interjections: Interjection[] = [];
  const moot: { driver: string; command: EngineCommand; reason: string }[] = [];
  const resumes: Resume[] = [];
  const acts: Act[] = [];
  const contests: Contest[] = [];
  const takeovers: Takeover[] = [];
  const downs: Down[] = [];
  // The move being played, counted from 1, and the drivers that are down until a later one.
  let move = 0;
  const downUntil = new Map<string, number>();
  let idle: string[] = [];
  // One connection for the whole run, which every driver process sees through its life. One
  // thread runs each transaction to its end before the next begins, so a connection per process
  // would show the same committed events and cost only page cache reloads. The terminal and the
  // checks use it as it is: they are never killed.
  const outside = withEventCache(openSqliteEventStore(path, { openDatabase }));
  const terminal: CommandLog = createCommandLog({ store: outside, recipes, reminderMs, routingMs });
  const holds = (owner: string, batchId: string): boolean =>
    outside.batchLeases(now).some((lease) => lease.batchId === batchId && lease.owner === owner);
  const interject = (driver: string): void => {
    const live = () =>
      [...terminal.state().batches.values()].filter(isLive).map((batch) => batch.id);
    const interjected = faults.interject(driver, live);
    if (interjected === undefined) return;
    const { batchId } = interjected;
    const command: Command = { ...interjected, ...human };
    const accepted = terminal.issue(command, now).kind === 'accepted';
    interjections.push({ move, driver, batchId, command, accepted });
  };
  const pause = async (driver: string): Promise<void> => {
    for (let turns = faults.pause(driver); turns > 0; turns--) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  /**
   * The fake runner of a driver process, which notes every attempt it starts and stops, and keeps
   * the attempts that run, by key.
   */
  const runnerOf = (life: Life): BrewerRunner & { running: Map<string, AttemptRef> } => {
    const runner = fakeBrewerRunner(({ ref }) => behaviourOf(plays(ref), now));
    const running = new Map<string, AttemptRef>();
    runners.push({
      life,
      runs: (key) => {
        const ref = running.get(key);
        return ref !== undefined && runner.progress(ref) !== undefined;
      },
    });
    return {
      running,
      start: (start) => {
        life.alive();
        const { driver } = life;
        const { batchId } = start.ref;
        const key = attemptKey.encode(start.ref);
        acts.push({ driver, kind: 'start', key, batchId, held: holds(driver, batchId) });
        const run = runner.start(start);
        running.set(key, start.ref);
        clone?.starting(start.ref);
        const ended = (): void => {
          running.delete(key);
        };
        run.ended.then(ended, ended);
        return {
          ended: run.ended,
          stop: () => {
            stops.push({ driver, key });
            run.stop();
          },
        };
      },
      progress: runner.progress,
    };
  };

  // The owners whose driver started once at least: a start after that one is a restart.
  const startedOnce = new Set<string>();

  /** Starts a new process of `owner`'s driver, until one survives its start, drive and effects. */
  const boot = async (owner: string): Promise<Process> => {
    for (;;) {
      const life = kill.life(owner);
      const read = (lease: BatchLease | undefined): void => {
        if (lease === undefined || lease.owner === owner) return;
        const { batchId } = lease;
        const down = downUntil.has(lease.owner)
          ? downs.findLast((earlier) => earlier.driver === lease.owner)
          : undefined;
        if (lease.expiresAt > now) contests.push({ driver: owner, batchId, holder: lease.owner });
        else if (down !== undefined) {
          takeovers.push({ driver: owner, batchId, from: lease.owner, why: down.why });
        }
      };
      const runner = runnerOf(life);
      const report = (notice: DriverNotice): void => {
        // A refusal in the batch an accepted terminal command changed before this driver's
        // transaction, in the same move.
        if (
          notice.kind === 'refused' &&
          interjections.some(
            (i) =>
              i.accepted &&
              i.move === move &&
              i.driver === owner &&
              i.batchId === batchOf(notice.command),
          )
        ) {
          moot.push({ driver: owner, command: notice.command, reason: notice.reason });
        }
        if (notice.kind !== 'batch_lost') return;
        const { batchId } = notice;
        const ran = [...runner.running].filter(([, ref]) => ref.batchId === batchId);
        losses.push({ driver: owner, batchId, running: ran.map(([key]) => key) });
      };
      const applying = (key: string): void => {
        const { batchId } = effectKey.decode(key);
        acts.push({ driver: owner, kind: 'apply', key, batchId, held: holds(owner, batchId) });
      };
      const leased = outside
        .batchLeases(now)
        .filter((lease) => lease.owner === owner)
        .map((lease) => lease.batchId);
      const store = killableStore(outside, life, { read, beginning: () => interject(owner) });
      try {
        const stateBranch = branch?.handle(life, store);
        await stateBranch?.start();
        const driver = await openDriver({
          store,
          runner,
          recipes,
          clock: () => now,
          lock: () => locks.take(life),
          takes: () => true,
          stateBranch: stateBranch ?? { flush: async () => ({ kind: 'unchanged' }) },
          ...(clone === undefined
            ? {}
            : {
                worktrees: [{ repo: chaosRepo, base: 'origin/main', manager: clone.manager(life) }],
              }),
          limits: () => ({ ...defaultLimits, ...scenarioLimits }),
          effects: {
            due: (state, batchId) => {
              const batch = state.batches.get(batchId);
              return batch === undefined ? [] : batchEffectsDue(batch);
            },
            target: host.target(life, { pause: () => pause(owner), applying }),
          },
          reminderMs,
          routingMs,
          report,
        });
        if (startedOnce.has(owner)) {
          resumes.push({ driver: owner, leased, held: driver.held(), actsBefore: acts.length });
        }
        startedOnce.add(owner);
        // A new driver takes over its leases, starts the attempts that were scheduled and applies
        // the effects due.
        await driver.drive();
        await driver.applyEffects();
        if (!life.dead) return { life, driver, running: runner.running };
      } catch (error) {
        if (!(error instanceof EngineKilled)) throw error;
      }
      restarts.push(now);
    }
  };
  const processes = new Map<string, Process>();
  try {
    for (const owner of drivers) processes.set(owner, await boot(owner));
  } catch (error) {
    // A run that fails to start leaves no connection open: Windows could not remove its files.
    outside.close();
    throw error;
  }
  const processOf = (owner: string): Process => {
    const found = processes.get(owner);
    if (found === undefined) throw new Error(`No driver ${owner}`);
    return found;
  };

  const restart = async (owner: string): Promise<void> => {
    restarts.push(now);
    processes.set(owner, await boot(owner));
  };

  /** Keeps `owner`'s driver down from this move on, for `moves` moves. */
  const keepDown = (owner: string, why: Down['why'], moves: number): void => {
    const down = { driver: owner, why, from: move, until: move + moves };
    downs.push(down);
    downUntil.set(owner, down.until);
  };

  /**
   * Runs `fn` on `owner`'s driver, unless it is down until a later move or stalls now; when it
   * dies, starts it again at once, or keeps it down for a few moves. `settle` starts every driver
   * that is down and lets none stall or stay down: the run is ending.
   */
  const surviving = async (
    owner: string,
    fn: (driver: Driver) => Promise<void>,
    settle: boolean,
  ): Promise<'lived' | 'died' | 'idle'> => {
    const until = downUntil.get(owner);
    if (until !== undefined) {
      if (!settle && move < until) return 'idle';
      downUntil.delete(owner);
      // A stalled driver goes on where it was; a killed one starts again.
      if (processOf(owner).life.dead) await restart(owner);
    } else if (!settle) {
      const stalls = faults.stall(owner, processOf(owner).running.size > 0);
      if (stalls > 0) {
        keepDown(owner, 'stalled', stalls);
        return 'idle';
      }
    }
    const { life, driver } = processOf(owner);
    try {
      await fn(driver);
    } catch (error) {
      if (!(error instanceof EngineKilled)) throw error;
    }
    // A kill the driver caught and reported (a failed effect, a failed tick) still killed it.
    if (!life.dead) return 'lived';
    const downFor = settle ? 0 : faults.down(owner);
    if (downFor > 0) keepDown(owner, 'killed', downFor);
    else await restart(owner);
    return 'died';
  };

  /**
   * Runs `fn` on every driver at once, the first picked at random; true when one ran at least and
   * every one that ran lived through it.
   */
  const everyDriver = async (
    fn: (driver: Driver) => Promise<void>,
    settle = false,
  ): Promise<boolean> => {
    const first = faults.first(drivers.length);
    const order = [...drivers.slice(first), ...drivers.slice(0, first)];
    const ran = await Promise.all(order.map((owner) => surviving(owner, fn, settle)));
    idle = order.filter((_, i) => ran[i] === 'idle');
    return idle.length < ran.length && ran.every((what) => what !== 'died');
  };

  const play = async (next: Move, site = move + 1): Promise<boolean> => {
    move++;
    kill.moved(site);
    switch (next.kind) {
      case 'command':
        // A command from the terminal, beside the drivers; they drive on what it decided.
        terminal.issue(next.command, now);
        return everyDriver(async (driver) => {
          await driver.drive();
          await driver.applyEffects();
        });
      case 'tick':
        now = new Date(now.getTime() + next.advanceMs);
        return everyDriver((driver) => driver.tick());
      default: {
        const unhandled: never = next;
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
    faults: faults.made,
    idle: () => idle,
    applyEffects: async () => {
      await everyDriver((driver) => driver.applyEffects(), true);
    },
    kills: kill.kills,
    restarts,
    acts,
    contests,
    takeovers,
    downs,
    losses,
    stops,
    interjections,
    moot,
    resumes,
    clone,
    branch,
    get found() {
      return host.found;
    },
    close: () => {
      for (const { life, driver } of processes.values()) if (!life.dead) driver.close();
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
  atEnd?(run: ChaosRun): void | Promise<void>;
}

/**
 * The number each move of a run had in the run as first played, where its faults are (`Fault`):
 * one per move the source gives, and the number the ticks that let the batches come to rest
 * count on from. A run as first played numbers its moves 1, 2, … and its ticks after them.
 */
export interface MoveSites {
  moves: readonly number[];
  settleFrom?: number;
}

const playedSites: MoveSites = { moves: [] };

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
  sites: MoveSites = playedSites,
): Promise<void> => {
  const { engine } = run;
  const step = async (move: Move, site: number): Promise<boolean> => {
    run.moves.push(move);
    const survived = await engine.play(move, site);
    checks.afterMove?.(run, move, survived);
    return survived;
  };
  let played = 0;
  for (let move = source.move(engine.state()); move !== undefined; ) {
    await step(move, sites.moves[played] ?? played + 1);
    played++;
    move = source.move(engine.state());
  }
  let site = sites.settleFrom ?? played;
  // Until no batch is brewing, and at least once: the last tick must be one every driver ran in
  // and lived through, or a deadline that came due before a kill would never be seen.
  let ticked = false;
  for (let ticks = 0; !ticked || brewing(engine.state()).length > 0; ticks++) {
    if (ticks === maxSettleTicks) {
      throw new Error(
        `Batches still brewing after ${maxSettleTicks} ticks of ${settleMs / 60_000} min: ` +
          brewing(engine.state()).join(', '),
      );
    }
    const survived = await step({ kind: 'tick', advanceMs: settleMs }, ++site);
    ticked = survived && engine.idle().length === 0;
  }
  // A kill may have ended the last pass before an effect was recorded.
  await engine.applyEffects();
  await checks.atEnd?.(run);
};
