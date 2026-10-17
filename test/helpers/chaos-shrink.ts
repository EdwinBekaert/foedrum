// Chaos runs over seeds (#15, #144): each seed's generated scenario played with its kill plan, and
// a failure reported with the seed, the kills, the moves and the events.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { removeTree } from '../../src/platform/remove.ts';
import {
  type ChaosChecks,
  type ChaosEngine,
  type ChaosOptions,
  type ChaosRun,
  fakeCodeHost,
  killPlan,
  openChaosEngine,
  runChaos,
} from './chaos.ts';
import { generateScenario, type Move, recording, type Scenario } from './event-sequences.ts';
import {
  describeCommand,
  describeEvent,
  describePlay,
  forEachSeedAsync,
  noted,
} from './property.ts';

/** Seeds per chaos property in npm run check, where the chaos layer has a time ceiling. */
const chaosRuns = 5;

/**
 * Runs the generated scenario of each seed with that seed's kill plan, on a database in `dir`, and
 * checks `checks`. A failure names the seed and shows the kills, the moves and the events.
 */
export const holdsAcrossKills = (
  dir: string,
  checks: ChaosChecks,
  options: ChaosOptions = {},
): Promise<void> =>
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
      const plays = (attempt: AttemptRef) => source.play(attempt);
      engine = await openChaosEngine(path, plays, killPlan(seed), host, options);
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
