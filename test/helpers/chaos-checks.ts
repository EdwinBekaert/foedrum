// The checks every chaos run must pass (#15, ADR 0033), for the chaos tests to share.

import assert from 'node:assert/strict';
import { check } from '../../src/engine/admit.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { emptyState, type State } from '../../src/engine/fold.ts';
import {
  type ChaosChecks,
  type ChaosEngine,
  type ChaosRun,
  effectsDue,
  progressComment,
} from './chaos.ts';
import { running } from './simulation.ts';

/**
 * The batches whose live lease a driver that is down holds: no other driver acts on them until
 * that lease expired (ADR 0044).
 */
const heldByTheDown = ({ engine }: ChaosRun): Set<string> => {
  const idle = new Set(engine.idle());
  return new Set(
    engine
      .store()
      .batchLeases(engine.now())
      .filter((lease) => idle.has(lease.owner))
      .map((lease) => lease.batchId),
  );
};

/**
 * Every batch's pending deadline is ahead: its running attempts', its routing deadline or its
 * reminder. Except a batch a driver that is down holds.
 */
export const nothingOverdue = (run: ChaosRun): void => {
  const { engine } = run;
  const now = engine.now().getTime();
  const waiting = heldByTheDown(run);
  for (const batch of engine.state().batches.values()) {
    if (waiting.has(batch.id)) continue;
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

/**
 * Nothing waits for a driver that is gone: every scheduled attempt is started and every effect due
 * is in the ledger, except in a batch a driver that is down holds. Once that lease expired, the
 * other driver takes the batch over (ADR 0044). And except in a batch a terminal command changed
 * in this move: one that came after the drivers' last drive waits for their next (ADR 0044). And
 * except an attempt whose step another attempt still holds a live lease of.
 */
export const nothingLeftWaiting = (run: ChaosRun): void => {
  const { engine } = run;
  const waiting = heldByTheDown(run);
  for (const { move, batchId } of engine.interjections) {
    if (move === run.moves.length) waiting.add(batchId);
  }
  const state = engine.state();
  // Steps with a live attempt lease: one Stuck abandoned may hold it until its run ends or the
  // lease expires, and the next attempt of the step waits for that (I2, #150); its deadline still
  // runs (nothingOverdue).
  const leased = new Set(
    engine
      .store()
      .currentLeases(engine.now())
      .flatMap(({ attemptKey: key }) => attemptKey.decode(key) ?? [])
      .map((ref) => `${ref.batchId} ${ref.stepId}`),
  );
  for (const batch of state.batches.values()) {
    if (waiting.has(batch.id) || batch.lane.kind !== 'brewing') continue;
    for (const attempt of running(batch)) {
      if (attempt.phase === 'scheduled' && leased.has(`${batch.id} ${attempt.stepId}`)) continue;
      assert.notEqual(
        attempt.phase,
        'scheduled',
        `batch ${batch.id} has ${attempt.stepId}#${attempt.attempt} scheduled and not started`,
      );
    }
  }
  for (const key of effectsDue(state)) {
    if (waiting.has(key.batchId)) continue;
    const text = effectKey.encode(key);
    assert.ok(state.effects.has(text), `effect ${text} is due and not in the ledger`);
  }
};

// What the guard has accepted of each run's log so far, so each check reads only the new events.
const guarded = new WeakMap<ChaosEngine, { state: State; lastId: number }>();

/**
 * The log holds: every committed event is one the guard accepts after the events before it, as
 * when it was decided. Two writers that decided on what they read before their transaction would
 * append events the guard refuses (ADR 0044).
 */
export const theLogHolds = ({ engine }: ChaosRun): void => {
  const seen = guarded.get(engine) ?? { state: emptyState, lastId: 0 };
  const stored = engine.store().eventsAfter(seen.lastId);
  for (const { id, event } of stored) {
    const checked = check(seen.state, event);
    if (checked.kind === 'refused') assert.fail(`event ${id} breaks the log: ${checked.reason}`);
    seen.state = checked.state;
    seen.lastId = id;
  }
  guarded.set(engine, seen);
};

/** I2 across restarts: the leases a killed engine left behind count too. */
export const oneLeasePerStep = ({ engine }: ChaosRun): void => {
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

/** Every batch comes to rest, no effect is applied twice or lost, none sits past its deadline. */
export const restsWithEffectsOnce: Required<ChaosChecks> = {
  afterMove: (run, move, survived) => {
    oneLeasePerStep(run);
    // A tick every driver that ran lived through has handled every deadline that was due (I5, I1).
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
};
