// Chaos runs over seeds (#15, #144): each seed's generated scenario played with its kill plan, or a
// schedule replayed, and a failure reported with the kills, the moves and the events.

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
    source = recording(generateScenario(play.seed), scenario);
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
 * Runs `seed`'s generated scenario with its kill plan on a database in `dir`, and checks
 * `checks`. A failure is thrown with the kills, the moves and the events.
 */
export const checkSeed = async (
  dir: string,
  seed: number,
  checks: ChaosChecks,
  options: ChaosOptions = {},
): Promise<void> => {
  const failure = await trialChaos(dir, { seed }, checks, options);
  if (failure === undefined) return;
  throw noted(failure.error, failure.report);
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

const numbered = (lines: readonly string[]): string =>
  lines.length === 0
    ? '    (none)'
    : lines.map((line, i) => `  ${String(i + 1).padStart(3)}. ${line}`).join('\n');

const describeMove = (move: Move): string =>
  move.kind === 'command' ? describeCommand(move.command) : `tick +${move.advanceMs / 60_000} min`;

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
