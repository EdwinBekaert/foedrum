// Invariant I1 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { holdsInScenarios } from '../helpers/property.ts';
import { farFuture, recipes, running } from '../helpers/simulation.ts';

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
            // One attempt in flight, or one per child of a parallel group that has not ended
            // (ADR 0168); none at all would be a batch sitting silently.
            const attempts = running(batch);
            const [first] = attempts;
            assert.ok(first !== undefined, `brewing batch ${batch.id} runs no attempt`);
            if (attempts.length > 1) {
              const recipe = recipes.find(batch.recipe?.name ?? '');
              const groups = new Set(attempts.map(({ stepId }) => recipe?.group(stepId)));
              assert.ok(
                groups.size === 1 && !groups.has(undefined),
                `brewing batch ${batch.id} runs ${attempts.length} attempts, not all in one parallel group: ${attempts.map(({ stepId }) => stepId).join(', ')}`,
              );
            }
            const earliest = attempts
              .map(({ deadlineAt }) => iso(deadlineAt))
              .sort()
              .at(0);
            assert.equal(
              deadline,
              earliest,
              `the deadline of batch ${batch.id} is its earliest attempt's`,
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
