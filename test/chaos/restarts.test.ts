// The engine killed at random points and restarted (#15, the M0 exit criterion): every batch comes
// to rest, no side effect is applied twice or lost, and no batch sits past its deadline. The run
// count is FOEDRUM_RUNS (a few in npm run check, 1,000 in the nightly run).

import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { type ChaosRun, effectsDue, holdsAcrossKills, progressComment } from '../helpers/chaos.ts';
import { running } from '../helpers/simulation.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-restarts');
});
after(() => dir.remove());

/** Every batch's pending deadline is ahead: its running attempts', its routing deadline or its reminder. */
const nothingOverdue = ({ engine }: ChaosRun): void => {
  const now = engine.now().getTime();
  for (const batch of engine.state().batches.values()) {
    const { lane } = batch;
    switch (lane.kind) {
      case 'brewing':
        for (const attempt of running(batch)) {
          assert.ok(
            Date.parse(attempt.deadlineAt) > now,
            `batch ${batch.id} is brewing past the deadline of ${attempt.stepId}#${attempt.attempt}, ${attempt.deadlineAt}`,
          );
        }
        break;
      case 'conditioning':
      case 'stuck':
        assert.ok(
          Date.parse(lane.remindAt) > now,
          `batch ${batch.id} is ${lane.kind} past its reminder, ${lane.remindAt}`,
        );
        break;
      // An Ordered batch waits to be routed by its routing deadline (ADR 0032), so one whose
      // routing a kill lost gets Stuck instead of sitting silently.
      case 'ordered':
        assert.ok(
          Date.parse(lane.routeBy) > now,
          `batch ${batch.id} is ordered past its routing deadline, ${lane.routeBy}`,
        );
        break;
      case 'on_tap':
      case 'cancelled':
        break;
      default: {
        const unhandled: never = lane;
        throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
      }
    }
  }
};

/** I2 across restarts: the leases a killed engine left behind count too. */
const oneLeasePerStep = ({ engine }: ChaosRun): void => {
  const byStep = new Map<string, string[]>();
  for (const lease of engine.store().currentLeases(engine.now())) {
    const ref = attemptKey.decode(lease.attemptKey);
    assert.ok(ref, `lease ${lease.attemptKey} names an attempt`);
    const step = `${ref.batchId} ${ref.stepId}`;
    byStep.set(step, [...(byStep.get(step) ?? []), lease.attemptKey]);
  }
  for (const [step, keys] of byStep) {
    assert.equal(keys.length, 1, `step ${step} has live leases ${keys.join(', ')}`);
  }
};

it('every batch comes to rest, no effect is applied twice or lost, none sits past its deadline', () =>
  holdsAcrossKills(dir.path, {
    afterMove: (run, move, survived) => {
      oneLeasePerStep(run);
      // A tick the engine lived through has handled every deadline that was due (I5, I1).
      if (move.kind === 'tick' && survived) nothingOverdue(run);
    },
    atEnd: (run) => {
      const state = run.engine.state();
      // runChaos gets here only once no batch is brewing, and fails when they never stop: that
      // is the check that every batch comes to rest. This one guards against a lane added later.
      const now = run.engine.now().getTime();
      for (const batch of state.batches.values()) {
        const { lane } = batch;
        // Ordered only while its routing deadline is ahead: past it, the batch is Stuck.
        const waiting = lane.kind === 'ordered' && Date.parse(lane.routeBy) > now;
        assert.ok(
          waiting || ['on_tap', 'cancelled', 'stuck', 'conditioning'].includes(lane.kind),
          `batch ${batch.id} is at rest, not ${lane.kind}`,
        );
      }
      for (const [key, results] of run.host.applied) {
        assert.equal(results.length, 1, `effect ${key} applied ${results.length} times`);
        assert.deepStrictEqual(state.effects.get(key), results[0], `the ledger has ${key}`);
      }
      for (const key of effectsDue(state)) {
        const text = effectKey.encode(key);
        assert.ok(run.host.applied.has(text), `effect ${text} reached the code host`);
      }
      for (const key of state.effects.keys()) {
        if (effectKey.decode(key).effect !== progressComment) continue;
        assert.ok(run.host.applied.has(key), `recorded effect ${key} is on the code host`);
      }
    },
  }));
