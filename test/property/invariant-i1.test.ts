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
            // One attempt in flight per batch until parallel groups have their transitions
            // (ADR 0025); none at all would be a batch sitting silently.
            const attempts = running(batch);
            const [attempt] = attempts;
            assert.ok(
              attempt !== undefined && attempts.length === 1,
              `brewing batch ${batch.id} runs one attempt, not ${attempts.length}`,
            );
            assert.equal(
              deadline,
              iso(attempt.deadlineAt),
              `the deadline of batch ${batch.id} is its attempt's`,
            );
            break;
          }
          // An ordered batch waits to be routed by its routing deadline (ADR 0032).
          case 'ordered':
            assert.equal(
              deadline,
              iso(lane.routeBy),
              `the deadline of batch ${batch.id} is its routing deadline`,
            );
            break;
          case 'conditioning':
          case 'stuck':
            assert.equal(
              deadline,
              iso(lane.remindAt),
              `the deadline of batch ${batch.id} is its reminder`,
            );
            break;
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
