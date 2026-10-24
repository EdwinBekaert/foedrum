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
import { openEngine, running, runScenario } from '../helpers/simulation.ts';

/** What a scenario did: the events it appended, and why the engine refused what it refused. */
interface Played {
  events: Event[];
  refusals: string[];
}

/** Plays `scenario`; generated from `seed` and recorded into it when one is given. */
const play = async (scenario: Scenario, seed?: number): Promise<Played> => {
  const source =
    seed === undefined ? replaying(scenario) : recording(generateScenario(seed), scenario);
  const engine = openEngine((attempt) => source.play(attempt));
  try {
    await runScenario(engine, source);
    return { events: engine.events(), refusals: [...engine.brewing.refusals] };
  } finally {
    engine.close();
  }
};

/** What happened in a scenario that a property needs scenarios to reach. */
const reached = ({ events, refusals }: Played): Set<string> => {
  const seen = new Set<string>();
  // Effects the engine must refuse (invariant I4): of an attempt that never existed, and twice.
  for (const reason of refusals) {
    if (/^attempt .* was never scheduled$/.test(reason)) seen.add('effect of no attempt refused');
    if (/^effect .* was already applied$/.test(reason)) seen.add('effect applied twice refused');
  }
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
    // A parallel group's children in flight side by side, and its verdict sending the batch back
    // (ADR 0168).
    if (event.type === 'step.started') {
      const batch = state.batches.get(event.batchId);
      if (
        batch !== undefined &&
        running(batch).filter(({ phase }) => phase === 'started').length > 1
      ) {
        seen.add('attempts side by side');
      }
    }
    if (
      event.type === 'step.scheduled' &&
      ['correctness', 'test-design'].includes(event.route?.from ?? '')
    ) {
      seen.add('a group sent back by a blocking child');
    }
  }
  return seen;
};

describe('engine scenarios', () => {
  it('append the same events when replayed, so a failing one can be shrunk', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      const scenario: Scenario = { moves: [], plays: [] };
      const played = await play(scenario, seed);
      assert.deepStrictEqual(await play(scenario), played, `seed ${seed}`);
    }
  });

  it('reach lost and stalled attempts, reminders, rewinds from Stuck, denial storms and parallel groups', async () => {
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
      'effect of no attempt refused',
      'effect applied twice refused',
      'batch.on_tap',
      'batch.cancelled',
      'attempts side by side',
      'a group sent back by a blocking child',
    ];
    const seen = new Set<string>();
    // Fixed seeds, so what the generator reaches does not depend on FOEDRUM_SEED: the first ones
    // until every goal is reached, within a bound, as the chaos kills test does.
    for (let seed = 1; seed <= 60 && wanted.some((what) => !seen.has(what)); seed++) {
      for (const what of reached(await play({ moves: [], plays: [] }, seed))) seen.add(what);
    }
    assert.deepStrictEqual(
      wanted.filter((what) => !seen.has(what)),
      [],
    );
  });
});
