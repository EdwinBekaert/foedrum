// Invariant I5 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { holdsInScenarios } from '../helpers/property.ts';
import { running } from '../helpers/simulation.ts';

it('I5: a batch past its deadline becomes stuck within one supervisor tick', () =>
  holdsInScenarios({
    afterMove: (engine, move, before) => {
      if (move.kind !== 'tick') return;
      const now = engine.now().getTime();
      for (const batch of before.batches.values()) {
        const { lane: was } = batch;
        // An ordered batch past its routing deadline (ADR 0032).
        if (was.kind === 'ordered' && Date.parse(was.routeBy) <= now) {
          const { lane } = engine.state().batches.get(batch.id) ?? batch;
          assert.equal(lane.kind, 'stuck', `batch ${batch.id} after the tick`);
          assert.equal(lane.reason.kind, 'routing', `why batch ${batch.id} is stuck`);
          continue;
        }
        // Only a brewing batch runs attempts: a cancelled one keeps its last attempt unfinished.
        if (batch.lane.kind !== 'brewing') continue;
        const late = running(batch).filter((attempt) => Date.parse(attempt.deadlineAt) <= now);
        if (late.length === 0) continue;
        const { lane } = engine.state().batches.get(batch.id) ?? batch;
        assert.equal(lane.kind, 'stuck', `batch ${batch.id} after the tick`);
        assert.equal(lane.reason.kind, 'deadline_passed', `why batch ${batch.id} is stuck`);
      }
    },
  }));
