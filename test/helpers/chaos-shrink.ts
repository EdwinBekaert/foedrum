// Chaos runs over seeds (#15, #144): each seed's generated scenario played with its kill plan. A
// run that fails is shrunk to the smallest schedule that still fails the same way, and reported
// with its seed, the faults and moves that are left, and the events they appended.
//
// A schedule is the run's moves and plays and its faults, each fault at its site: the move by its
// number in the run as first played, the driver, and its count among decisions of its kind in that
// move (`Fault`). Removing a move takes only its own faults along, and every other fault stays
// where it was, which a count over the whole run would not do (#150).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { removeTree } from '../../src/platform/remove.ts';
import {
  type ChaosChecks,
  type ChaosEngine,
  type ChaosOptions,
  type ChaosRun,
  type Fault,
  fakeCodeHost,
  killPlan,
  type MoveSites,
  openChaosEngine,
  runChaos,
} from './chaos.ts';
import {
  generateScenario,
  type Move,
  type MoveSource,
  recording,
  replaying,
  type Scenario,
} from './event-sequences.ts';
import {
  describeCommand,
  describeEvent,
  describePlay,
  forEachSeedAsync,
  noted,
} from './property.ts';

/** Seeds per chaos property in npm run check, where the chaos layer has a time ceiling. */
const chaosRuns = 5;

/** How many runs shrinking may replay before it reports what it has. */
const shrinkBudget = 250;

/** What a chaos run plays: its moves, each at its site (`MoveSites`), its plays and its faults. */
export interface ChaosSchedule {
  moves: { site: number; move: Move }[];
  /** The number the ticks after the moves count on from: the moves of the run as first played. */
  settleFrom: number;
  plays: Scenario['plays'];
  faults: Fault[];
}

/** A run that failed: the error, what it did, and the schedule it played, faults reached only. */
export interface ChaosFailure {
  error: unknown;
  report: string;
  schedule: ChaosSchedule;
}

/** The first failing run of a seed, before shrinking. */
export interface FoundFailure {
  seed: number;
  failure: ChaosFailure;
}

let trials = 0;

/**
 * Plays `seed`'s generated scenario with its kill plan, or replays `schedule`, on a database of
 * its own in `dir`, and checks `checks`: how it failed, or undefined when it held.
 */
export const trialChaos = async (
  dir: string,
  play: { seed: number } | { schedule: ChaosSchedule },
  checks: ChaosChecks,
  options: ChaosOptions = {},
): Promise<ChaosFailure | undefined> => {
  // A folder per run: the database, its -wal and -shm files go together.
  const folder = join(dir, `run-${++trials}`);
  mkdirSync(folder);
  const scenario: Scenario = { moves: [], plays: [] };
  let source: MoveSource;
  let sites: MoveSites;
  let faults: ChaosOptions['faults'];
  if ('seed' in play) {
    source = recording((options.moves ?? generateScenario)(play.seed), scenario);
    sites = { moves: [] };
  } else {
    const { moves, settleFrom, plays } = play.schedule;
    source = recording(replaying({ moves: moves.map(({ move }) => move), plays }), scenario);
    sites = { moves: moves.map(({ site }) => site), settleFrom };
    faults = play.schedule.faults;
  }
  const seed = 'seed' in play ? play.seed : 0;
  const host = fakeCodeHost();
  let engine: ChaosEngine | undefined;
  const moves: Move[] = [];
  try {
    const plays = (attempt: AttemptRef) => source.play(attempt);
    engine = await openChaosEngine(join(folder, 'events.sqlite'), plays, killPlan(seed), host, {
      ...options,
      ...(faults === undefined ? {} : { faults }),
    });
    await runChaos({ engine, host, scenario, moves }, source, checks, sites);
    return undefined;
  } catch (error) {
    // The moves of the scenario that were played, at their sites; the settling ticks follow.
    const played = scenario.moves.map((move, i) => ({ site: sites.moves[i] ?? i + 1, move }));
    const schedule: ChaosSchedule = {
      moves: played,
      settleFrom: sites.settleFrom ?? played.length,
      plays: scenario.plays,
      faults: [...(engine?.faults ?? [])],
    };
    const run = engine === undefined ? '' : report({ engine, host, scenario, moves });
    return { error, report: run, schedule };
  } finally {
    engine?.close();
    // With retries for files Windows still holds; what is left goes with `dir`, and a failed
    // removal never hides the run's own error.
    await removeTree(folder).catch(() => {});
  }
};

/**
 * What a failure is, for shrinking to keep: the error's name and the first line of its message,
 * with every number in it left out, since a smaller run names other batches and attempts.
 */
export const failureKind = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${(message.split('\n')[0] ?? '').replace(/\d+/g, '#')}`;
};

/** A shrunk failure, with how many runs shrinking replayed and whether it ran out of them. */
export interface Shrunk {
  failure: ChaosFailure;
  runs: number;
  exhausted: boolean;
}

/**
 * Shrinks `found` to a smallest schedule that still fails the same way (`failureKind`): it
 * removes chunks of moves, then of faults, halving the chunk down to one, over and over until
 * neither goes; then it makes each play that is left a success where that still fails. Each
 * removal keeps every other fault at its site.
 */
export const shrinkChaos = async (
  dir: string,
  found: FoundFailure,
  checks: ChaosChecks,
  options: ChaosOptions = {},
  budget = shrinkBudget,
): Promise<Shrunk> => {
  const kind = failureKind(found.failure.error);
  let best = found.failure;
  let runs = 0;
  const fails = async (schedule: ChaosSchedule): Promise<boolean> => {
    if (runs >= budget) return false;
    runs++;
    const failure = await trialChaos(dir, { schedule }, checks, options);
    if (failure === undefined || failureKind(failure.error) !== kind) return false;
    best = failure;
    return true;
  };
  /** Removes chunks of what `part` picks out of the best schedule; true when one went. */
  const removeChunks = async <T>(
    part: (schedule: ChaosSchedule) => T[],
    without: (schedule: ChaosSchedule, items: T[]) => ChaosSchedule,
  ): Promise<boolean> => {
    let changed = false;
    for (let chunk = Math.ceil(part(best.schedule).length / 2); chunk >= 1; ) {
      let removed = false;
      for (let at = 0; at < part(best.schedule).length; ) {
        const items = part(best.schedule);
        const candidate = without(best.schedule, [
          ...items.slice(0, at),
          ...items.slice(at + chunk),
        ]);
        if (await fails(candidate)) removed = changed = true;
        else at += chunk;
      }
      if (!removed || chunk > 1) chunk = Math.floor(chunk / 2);
    }
    return changed;
  };
  for (let changed = true; changed && runs < budget; ) {
    const moves = await removeChunks(
      (schedule) => schedule.moves,
      (schedule, items) => ({ ...schedule, moves: items }),
    );
    const faults = await removeChunks(
      (schedule) => schedule.faults,
      (schedule, items) => ({ ...schedule, faults: items }),
    );
    changed = moves || faults;
  }
  for (let at = 0; at < best.schedule.plays.length; at++) {
    const { plays } = best.schedule;
    if (plays[at]?.play.kind === 'succeed') continue;
    await fails({
      ...best.schedule,
      plays: plays.map((entry, i) => (i === at ? { ...entry, play: { kind: 'succeed' } } : entry)),
    });
  }
  return { failure: best, runs, exhausted: runs >= budget };
};

/**
 * Runs `seed`'s generated scenario with its kill plan on a database in `dir`, and checks
 * `checks`. A failure is shrunk, and thrown with the seed, the schedule left and its events.
 */
export const checkSeed = async (
  dir: string,
  seed: number,
  checks: ChaosChecks,
  options: ChaosOptions = {},
): Promise<void> => {
  const failure = await trialChaos(dir, { seed }, checks, options);
  if (failure === undefined) return;
  const shrunk = await shrinkChaos(dir, { seed, failure }, checks, options);
  throw noted(shrunk.failure.error, counterexample(seed, failure, shrunk));
};

/**
 * Runs `checkSeed` for each seed, on databases in `dir`. A failure names the seed, which
 * FOEDRUM_SEED replays.
 */
export const holdsAcrossKills = (
  dir: string,
  checks: ChaosChecks,
  options: ChaosOptions = {},
): Promise<void> => forEachSeedAsync(chaosRuns, (seed) => checkSeed(dir, seed, checks, options));

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

const ordinal = (n: number): string =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** One fault on one line: where it was, and what it did. */
export const describeFault = ({ move, driver, kind, n, value }: Fault): string => {
  const where = `move ${move}${driver === '' ? '' : `, ${driver}`}`;
  const what = (): string => {
    if (kind.startsWith('kill ')) return `killed ${kind.slice('kill '.length)}`;
    if (typeof value === 'object' && 'to' in value) {
      return `the terminal: take over ${value.batchId} for ${value.to}`;
    }
    if (typeof value === 'object') return `the terminal: ${value.kind} ${value.batchId}`;
    switch (kind) {
      case 'pause':
        return `lets the others run ${count(value, 'turn')} at the code host`;
      case 'first':
        return `driver ${value} plays first`;
      case 'down':
        return `stays down ${count(value, 'move')}`;
      case 'stall':
        return `stalls ${count(value, 'move')}`;
      default:
        return `${kind} ${value}`;
    }
  };
  return `${where}: ${what()} (the ${ordinal(n + 1)} such decision in the move)`;
};

const numbered = (lines: readonly string[]): string =>
  lines.length === 0
    ? '    (none)'
    : lines.map((line, i) => `  ${String(i + 1).padStart(3)}. ${line}`).join('\n');

const describeMove = (move: Move): string =>
  move.kind === 'command' ? describeCommand(move.command) : `tick +${move.advanceMs / 60_000} min`;

/** The seed, what shrinking left of the first failure, and the shrunk run's report. */
const counterexample = (seed: number, first: ChaosFailure, shrunk: Shrunk): string => {
  const from = first.schedule;
  const to = shrunk.failure.schedule;
  const size = (schedule: ChaosSchedule): string =>
    `${count(schedule.moves.length, 'move')} and ${count(schedule.faults.length, 'fault')}`;
  const firstFound = failureKind(first.error);
  return [
    `Seed ${seed}, shrunk in ${count(shrunk.runs, 'run')} from ${size(from)} to ${size(to)}` +
      `${shrunk.exhausted ? ', when shrinking ran out of runs' : ''}. First found as: ${firstFound}`,
    'Faults left, at their sites (a move by its number in the run as first played):',
    numbered(to.faults.map(describeFault)),
    'Moves left, by their number in the run as first played:',
    numbered(to.moves.map(({ site, move }) => `(${site}) ${describeMove(move)}`)),
    'Plays left, by attempt (any other attempt succeeds):',
    numbered(to.plays.map(describePlay)),
    'The shrunk run:',
    shrunk.failure.report,
  ].join('\n');
};

/** The kills, moves, plays and events of `run`, numbered. */
const report = ({ engine, scenario, moves }: ChaosRun): string => {
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
    'Drivers down after a kill, or stalled:',
    numbered(
      engine.downs.map(
        ({ driver, why, from, until }) => `${driver} ${why}, from move ${from} until move ${until}`,
      ),
    ),
    "Terminal commands between a driver's read and its append:",
    numbered(
      engine.interjections.map(
        ({ move, driver, command, accepted }) =>
          `in move ${move}, before ${driver}: ${describeCommand(command)}, ${accepted ? 'accepted' : 'refused'}`,
      ),
    ),
    'Moves:',
    numbered(moves.map(describeMove)),
    'Plays, by attempt, in the order they started:',
    numbered(scenario.plays.map(describePlay)),
    'Events:',
    numbered(events),
  ].join('\n');
};
