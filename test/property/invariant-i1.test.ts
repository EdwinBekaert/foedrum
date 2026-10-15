// Invariant I1 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { holdsInScenarios } from '../helpers/property.ts';
import { farFuture, running } from '../helpers/simulation.ts';

it('I1: every non-terminal batch has exactly one pending action with a deadline', () =>
  holdsInScenarios({
    afterMove: (engine, move) => {
      // Times as the events write them, so a failure reads like the events it lists.
      const iso = (at: string | Date): string => new Date(at).toISOString();
      const pending = new Map(
        engine.store
          .batchesPastDeadline(farFuture)
          .map((due) => [due.batchId, iso(due.deadlineAt)]),
      );
      for (const batch of engine.state().batches.values()) {
        const { lane } = batch;
        const deadline = pending.get(batch.id);
        switch (lane.kind) {
          case 'brewing': {
            const [attempt, ...more] = running(batch);
            assert.equal(more.length, 0, `brewing batch ${batch.id} runs one attempt`);
            assert.equal(
              deadline,
              attempt && iso(attempt.deadlineAt),
              `the deadline of batch ${batch.id} is its attempt's`,
            );
            break;
          }
          case 'conditioning':
          case 'stuck':
            assert.equal(
              deadline,
              iso(lane.remindAt),
              `the deadline of batch ${batch.id} is its reminder`,
            );
            break;
          // An ordered batch waits for the intake to route it: until it has a recipe, it has no
          // step to schedule and no deadline.
          case 'ordered':
          case 'on_tap':
          case 'cancelled':
            assert.equal(deadline, undefined, `${batch.id} is ${lane.kind}`);
            break;
          default: {
            const unhandled: never = lane;
            throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
          }
        }
        if (move.kind === 'tick' && deadline !== undefined) {
          assert.ok(deadline > iso(engine.now()), `batch ${batch.id} waits ahead after a tick`);
        }
      }
      // A deadline the state does not explain shows as a command the supervisor cannot apply.
      assert.deepStrictEqual(engine.brewing.notices, []);
    },
  }));
