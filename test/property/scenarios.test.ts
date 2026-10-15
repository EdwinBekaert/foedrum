// The engine scenarios the invariant properties (#14) run on: what the generator reaches, and that
// a recorded scenario replays exactly, which shrinking a failing one depends on.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyState, fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import {
  generateScenario,
  recording,
  replaying,
  type Scenario,
} from '../helpers/event-sequences.ts';
import { openEngine, runScenario } from '../helpers/simulation.ts';

/** The events `scenario` appends; generated from `seed` and recorded into it when one is given. */
const play = async (scenario: Scenario, seed?: number): Promise<Event[]> => {
  const source =
    seed === undefined ? replaying(scenario) : recording(generateScenario(seed), scenario);
  const engine = openEngine((attempt) => source.play(attempt));
  try {
    await runScenario(engine, source);
    return engine.events();
  } finally {
    engine.close();
  }
};

/** What happened in `events` that a property needs scenarios to reach. */
const reached = (events: readonly Event[]): Set<string> => {
  const seen = new Set<string>();
  let state = emptyState;
  for (const event of events) {
    const lane = 'batchId' in event ? state.batches.get(event.batchId)?.lane.kind : undefined;
    switch (event.type) {
      case 'batch.stuck':
        seen.add(`stuck ${event.reason.kind}`);
        if (event.reason.kind === 'blocked' && event.reason.summary.includes('denials')) {
          seen.add('denial storm');
        }
        if (lane === 'stuck') seen.add('stuck reminder');
        break;
      case 'batch.waiting':
        if (lane === 'conditioning') seen.add('conditioning reminder');
        break;
      case 'step.finished':
        if (
          event.outcome.kind === 'failed' &&
          event.outcome.reason.startsWith('the attempt was lost')
        ) {
          seen.add('lost attempt');
        }
        break;
      default:
        seen.add(event.type);
    }
    state = fold([event], state);
  }
  return seen;
};

describe('engine scenarios', () => {
  it('append the same events when replayed, so a failing one can be shrunk', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const scenario: Scenario = { moves: [], plays: [] };
      const events = await play(scenario, seed);
      assert.deepStrictEqual(await play(scenario), events, `seed ${seed}`);
    }
  });

  it('reach lost and stalled attempts, reminders, rewinds from Stuck and denial storms', async () => {
    const seen = new Set<string>();
    // Fixed seeds: what the generator reaches does not depend on FOEDRUM_SEED.
    for (let seed = 1; seed <= 10; seed++) {
      for (const what of reached(await play({ moves: [], plays: [] }, seed))) seen.add(what);
    }
    const wanted = [
      'lost attempt',
      'stuck stalled',
      'stuck deadline_passed',
      'stuck attempts_exhausted',
      'stuck needs_input',
      'stuck blocked',
      'denial storm',
      'stuck reminder',
      'conditioning reminder',
      'batch.rewound',
      'input.received',
      'order.decomposed',
      'effect.applied',
      'batch.on_tap',
      'batch.cancelled',
    ];
    assert.deepStrictEqual(
      wanted.filter((what) => !seen.has(what)),
      [],
    );
  });
});
