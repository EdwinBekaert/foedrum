// Invariant I6 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { type Command, decide } from '../../src/engine/decide.ts';
import type { Lane } from '../../src/engine/fold.ts';
import { human } from '../helpers/event-sequences.ts';
import { holdsInScenarios } from '../helpers/property.ts';
import { type Engine, isLive, recipes, reminderMs } from '../helpers/simulation.ts';

const minute = 60_000;

/** Moves a batch on as the intake or a human would, without cancelling it. */
const moveOn = async (engine: Engine, batchId: string, lane: Lane): Promise<void> => {
  switch (lane.kind) {
    case 'ordered':
    case 'conditioning':
      await engine.command({
        kind: 'route',
        batchId,
        recipe: 'pint',
        reason: 'label',
        source: 'label',
      });
      return;
    case 'stuck': {
      const { reason } = lane;
      await engine.command(
        reason.kind === 'needs_input'
          ? {
              kind: 'answer',
              batchId,
              ...human,
              answers: reason.questions.map(({ q, recommended }) => ({ q, answer: recommended })),
            }
          : { kind: 'retry', batchId, ...human },
      );
      return;
    }
    // Brewing moves on by itself: the attempt ends, or the supervisor ends it.
    case 'brewing':
    case 'on_tap':
    case 'cancelled':
      return;
    default: {
      const unhandled: never = lane;
      throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
    }
  }
};

/** Every batch that is not terminal can be cancelled at once. */
const cancellable = (engine: Engine): void => {
  const context = { now: engine.now(), recipes, reminderMs };
  for (const batch of engine.state().batches.values()) {
    if (!isLive(batch)) continue;
    const cancel: Command = { kind: 'cancel', batchId: batch.id, ...human };
    assert.equal(decide(engine.state(), cancel, context).kind, 'accepted', batch.id);
  }
};

it('I6: from every reachable state, a terminal state is reachable', () =>
  holdsInScenarios({
    // Cancelled, from every state a scenario reaches.
    afterMove: cancellable,
    atEnd: async (engine) => {
      // On tap from where the scenario ends, without cancelling: the brewer succeeds from now
      // on, the intake routes, and humans answer or retry.
      engine.playFrom(() => ({ kind: 'succeed' }));
      for (let round = 0; round < 10; round++) {
        const live = [...engine.state().batches.values()].filter(isLive);
        if (live.length === 0) return;
        for (const { id, lane } of live) await moveOn(engine, id, lane);
        // Past every deadline and lease, so a hanging or lost attempt ends.
        await engine.tick(61 * minute);
      }
      const live = [...engine.state().batches.values()].filter(isLive);
      assert.deepStrictEqual(
        live.map((batch) => `${batch.id} ${batch.lane.kind}`),
        [],
        'batches that never went on tap',
      );
    },
  }));
