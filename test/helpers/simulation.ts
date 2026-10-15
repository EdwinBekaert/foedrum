// Runs engine scenarios (#14) through the real engine pieces: decide and the guard, the fold, the
// supervisor's ticks and the fake brewer runner, driven by test/helpers/brewing.ts against an
// in-memory event store, with a clock that only the scenario moves.

import { nonTerminal } from '../../src/engine/admit.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import type { Command } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch, State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { createBrewing, defaultLimits } from './brewing.ts';
import {
  type Move,
  type MoveSource,
  type Play,
  scenarioLimits,
  scenarioRecipes,
} from './event-sequences.ts';
import { type Behaviour, behave, fakeBrewerRunner } from './fake-brewer-runner.ts';
import { fakeRecipe, fakeRecipes } from './fake-recipes.ts';

export const t0 = new Date('2026-10-15T12:00:00.000Z');
/** How long Conditioning and Stuck batches wait between reminders in a scenario. */
export const reminderMs = 2 * 3_600_000;

export const recipes = fakeRecipes(
  Object.fromEntries(
    Object.entries(scenarioRecipes).map(([name, recipe]) => [name, fakeRecipe(recipe)]),
  ),
);

/** The fake runner's behaviour for `play`, for an attempt that starts at `now`. */
const behaviourOf = (play: Play, now: Date): Behaviour => {
  switch (play.kind) {
    case 'succeed':
      return behave.succeed();
    case 'fail':
      return behave.fail(play.retryable);
    case 'crash':
      return behave.crash();
    case 'lost':
      return behave.lost();
    case 'garbage':
      return behave.garbage();
    case 'missingOutDoc':
      return behave.missingOutDoc();
    case 'invalidOutDoc':
      return behave.invalidOutDoc();
    case 'exceedBudget':
      return behave.exceedBudget(scenarioLimits.maxTurns + 1);
    case 'needInput':
      return behave.needInput();
    case 'denialStorm':
      return behave.denialStorm(['Bash', 'WebFetch', 'Bash', 'Edit', 'Bash']);
    case 'blocked':
      return behave.blocked(play.blockerKind);
    case 'hang':
      return behave.hang({
        lastProgressAt: new Date(now.getTime() - play.idleMs),
        turnsWithoutProgress: play.turnsWithoutProgress,
      });
    default: {
      const unhandled: never = play;
      throw new Error(`Unhandled play ${JSON.stringify(unhandled)}`);
    }
  }
};

export interface Engine {
  readonly store: EventStore;
  readonly brewing: ReturnType<typeof createBrewing>;
  now(): Date;
  state(): State;
  events(): Event[];
  /** Decides `command`, appends its events and drives the attempts; false when it is refused. */
  command(command: Command): Promise<boolean>;
  /** Moves the clock on by `ms` and runs a supervisor tick. */
  tick(ms: number): Promise<void>;
  /** Where the plays of the attempts that start from now on come from. */
  playFrom(plays: (attempt: AttemptRef) => Play): void;
  close(): void;
}

export const openEngine = (plays: (attempt: AttemptRef) => Play): Engine => {
  const store = openSqliteEventStore(':memory:');
  let now = t0;
  let next = plays;
  const runner = fakeBrewerRunner(({ ref }) => behaviourOf(next(ref), now));
  const brewing = createBrewing({
    store,
    runner,
    recipes,
    clock: () => now,
    limits: () => ({ ...defaultLimits, ...scenarioLimits }),
    reminderMs,
  });
  return {
    store,
    brewing,
    now: () => now,
    state: brewing.state,
    events: brewing.events,
    command: async (command) => {
      const accepted = brewing.command(command);
      await brewing.drive();
      return accepted;
    },
    tick: async (ms) => {
      now = new Date(now.getTime() + ms);
      await brewing.tick();
    },
    playFrom: (plays) => {
      next = plays;
    },
    close: () => store.close(),
  };
};

/** Later than any deadline. */
export const farFuture = new Date(8.64e15);

export const isLive = (batch: Batch): boolean => nonTerminal.includes(batch.lane.kind);

/** The attempts of `batch` that run: each the latest of its step, neither finished nor abandoned. */
export const running = (batch: Batch) =>
  [...batch.steps.values()].flatMap((step) => {
    const latest = step.attempts.get(Math.max(...step.attempts.keys()));
    return latest && latest.phase !== 'finished' && latest.abandoned !== true
      ? [{ stepId: step.id, ...latest }]
      : [];
  });

/** Plays the moves of `source` on `engine`, calling `observe` after each with the state before it. */
export const runScenario = async (
  engine: Engine,
  source: MoveSource,
  observe: (move: Move, before: State) => void = () => {},
): Promise<void> => {
  for (;;) {
    const before = engine.state();
    const move = source.move(before);
    if (move === undefined) return;
    switch (move.kind) {
      case 'command':
        await engine.command(move.command);
        break;
      case 'tick':
        await engine.tick(move.advanceMs);
        break;
      default: {
        const unhandled: never = move;
        throw new Error(`Unhandled move ${JSON.stringify(unhandled)}`);
      }
    }
    observe(move, before);
  }
};
