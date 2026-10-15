// Property tests over seeded sequences (architecture §9). Each run starts from a fresh seed, a
// failure names it, and FOEDRUM_SEED replays it; FOEDRUM_RUNS sets how many seeds a property runs,
// so CI can run more than `npm run check` does.

import { randomInt } from 'node:crypto';
import type { Command } from '../../src/engine/decide.ts';
import type { State } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import {
  generateScenario,
  type Move,
  type MoveSource,
  recording,
  replaying,
  type Scenario,
} from './event-sequences.ts';
import { type Engine, openEngine, runScenario, t0 } from './simulation.ts';

const integer = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  // Otherwise a mistyped number runs no case at all, and every property passes.
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
  return parsed;
};

const replayed = integer('FOEDRUM_SEED', process.env.FOEDRUM_SEED);
const firstSeed = replayed ?? randomInt(2 ** 31);
const runsSet = integer('FOEDRUM_RUNS', process.env.FOEDRUM_RUNS);

/** How many seeds a property runs: one when replaying a seed, else FOEDRUM_RUNS or `runs`. */
export const runCount = (runs: number): number => (replayed === undefined ? (runsSet ?? runs) : 1);

const replayHint = (seed: number): string =>
  `Seed ${seed}: set the environment variable FOEDRUM_SEED to ${seed} to replay it.`;

/**
 * `error` with `text` added to its message, so the report still shows the failed assertion or the
 * code under test. The stack too: the test runner prints the stack, which holds the message as it
 * was when the error was made.
 */
const noted = (error: unknown, text: string): unknown => {
  if (!(error instanceof Error)) return new Error(`${String(error)}\n${text}`, { cause: error });
  const { message } = error;
  error.message = `${message}\n${text}`;
  if (error.stack?.includes(message)) error.stack = error.stack.replace(message, error.message);
  return error;
};

/** Runs `property` for `runs` seeds; a failure's message gains the seed. */
export const forEachSeed = (runs: number, property: (seed: number) => void): void => {
  for (let seed = firstSeed; seed < firstSeed + runCount(runs); seed++) {
    try {
      property(seed);
    } catch (error) {
      throw noted(error, replayHint(seed));
    }
  }
};

/** An invariant of the engine, checked as a scenario plays; each hook throws when it is broken. */
export interface Invariant {
  /** After every move, with the state before it. */
  afterMove?(engine: Engine, move: Move, before: State): void;
  /** Once the scenario is over. */
  atEnd?(engine: Engine): Promise<void> | void;
}

export interface ScenarioOptions {
  /** Seeds to run; default 15. */
  runs?: number;
  /** Moves per scenario; default 40. */
  length?: number;
}

/** How many scenarios shrinking may replay before it reports what it has. */
const shrinkBudget = 400;

/**
 * Plays a generated scenario per seed and checks `invariant` along the way. A failure is shrunk to
 * fewer moves and simpler plays that still fail, and reported with the seed, the moves, the plays
 * and the events they appended.
 */
export const holdsInScenarios = async (
  invariant: Invariant,
  { runs = 15, length = 40 }: ScenarioOptions = {},
): Promise<void> => {
  for (let seed = firstSeed; seed < firstSeed + runCount(runs); seed++) {
    const scenario: Scenario = { moves: [], plays: [] };
    const failed = await trial(recording(generateScenario(seed, length), scenario), invariant);
    if (failed === undefined) continue;
    const shrunk = await shrink(scenario, invariant, failed);
    throw noted(shrunk.failure.error, counterexample(seed, scenario, shrunk));
  }
};

interface Failure {
  error: unknown;
  events: Event[];
}

/** Plays `source` and checks `invariant`; how it failed, or `undefined` when it held. */
const trial = async (source: MoveSource, invariant: Invariant): Promise<Failure | undefined> => {
  const engine = openEngine((attempt) => source.play(attempt));
  try {
    await runScenario(engine, source, (move, before) =>
      invariant.afterMove?.(engine, move, before),
    );
    await invariant.atEnd?.(engine);
    return undefined;
  } catch (error) {
    return { error, events: engine.events() };
  } finally {
    engine.close();
  }
};

/**
 * Removes chunks of moves, halving the chunk size, while the scenario still fails; then makes each
 * play that is left a success when that still fails, and drops the plays no attempt reached.
 */
const shrink = async (
  original: Scenario,
  invariant: Invariant,
  failure: Failure,
): Promise<{ scenario: Scenario; failure: Failure }> => {
  let best = { scenario: original, failure };
  let budget = shrinkBudget;
  const fails = async (candidate: Scenario): Promise<boolean> => {
    if (budget-- <= 0) return false;
    const used: Scenario = { moves: [], plays: [] };
    const result = await trial(recording(replaying(candidate), used), invariant);
    if (result !== undefined) best = { scenario: used, failure: result };
    return result !== undefined;
  };
  for (let chunk = Math.ceil(best.scenario.moves.length / 2); chunk >= 1; ) {
    let removed = false;
    for (let at = 0; at < best.scenario.moves.length; ) {
      const { moves, plays } = best.scenario;
      const candidate = { moves: [...moves.slice(0, at), ...moves.slice(at + chunk)], plays };
      if (await fails(candidate)) removed = true;
      else at += chunk;
    }
    if (!removed || chunk > 1) chunk = Math.floor(chunk / 2);
  }
  for (let at = 0; at < best.scenario.plays.length; at++) {
    const { moves, plays } = best.scenario;
    if (plays[at]?.play.kind === 'succeed') continue;
    await fails({
      moves,
      plays: plays.map((entry, i) => (i === at ? { ...entry, play: { kind: 'succeed' } } : entry)),
    });
  }
  return best;
};

const counterexample = (
  seed: number,
  original: Scenario,
  shrunk: { scenario: Scenario; failure: Failure },
): string => {
  const { moves, plays } = shrunk.scenario;
  const numbered = (lines: readonly string[]): string =>
    lines.length === 0
      ? '    (none)'
      : lines.map((line, i) => `  ${String(i + 1).padStart(3)}. ${line}`).join('\n');
  const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;
  let clock = t0.getTime();
  const described = moves.map((move) => {
    if (move.kind === 'command') return describeCommand(move.command);
    clock += move.advanceMs;
    return `tick +${move.advanceMs / 60_000} min, at ${new Date(clock).toISOString()}`;
  });
  return [
    replayHint(seed),
    `Shrunk from ${count(original.moves.length, 'move')} and ` +
      `${count(original.plays.length, 'play')} to ${count(moves.length, 'move')} and ` +
      `${count(plays.length, 'play')}.`,
    `Moves (from ${t0.toISOString()}):`,
    numbered(described),
    'Plays, by attempt, in the order they started (any other attempt succeeds):',
    numbered(plays.map(describePlay)),
    'Events:',
    numbered(shrunk.failure.events.map(describeEvent)),
  ].join('\n');
};

/** `fields` without the ones already shown, as JSON; empty when nothing is left. */
const rest = (fields: object, shown: readonly string[]): string => {
  const left = Object.fromEntries(Object.entries(fields).filter(([key]) => !shown.includes(key)));
  return Object.keys(left).length === 0 ? '' : ` ${JSON.stringify(left)}`;
};

const describeCommand = (command: Command): string =>
  command.kind === 'record'
    ? `record ${describeEvent(command.event)}`
    : `${command.kind} ${'batchId' in command ? command.batchId : ''}${rest(command, ['kind', 'batchId', 'by', 'via'])}`;

const describePlay = ({ attempt, play }: Scenario['plays'][number]): string =>
  `${attempt.batchId} ${attempt.stepId}#${attempt.attempt}: ${play.kind}${rest(play, ['kind'])}`;

/** One event on one line: its type, batch, step and attempt, then its other fields. */
export const describeEvent = (event: Event): string => {
  const parts: string[] = [event.type];
  if ('batchId' in event) parts.push(event.batchId);
  if ('stepId' in event && 'attempt' in event) parts.push(`${event.stepId}#${event.attempt}`);
  return `${parts.join(' ')}${rest(event, ['type', 'batchId', 'stepId', 'attempt', 'by', 'via'])}`;
};
