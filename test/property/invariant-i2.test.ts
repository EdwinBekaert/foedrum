// Invariant I2 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { holdsInScenarios } from '../helpers/property.ts';

it('I2: at most one live lease per attempt and per worktree', () =>
  holdsInScenarios({
    afterMove: (engine) => {
      // The store keys leases by attempt, so one per attempt holds by construction. An attempt
      // works in its own worktree (ADR 0012), but the next attempt of its step may resume its
      // session, in that session's worktree (retryMode, ADR 0027): two live leases of one step
      // would be two attempts in one worktree.
      const byStep = new Map<string, string[]>();
      for (const lease of engine.store.currentLeases(engine.now())) {
        const ref = attemptKey.decode(lease.attemptKey);
        assert.ok(ref, `lease ${lease.attemptKey} names an attempt`);
        const step = `${ref.batchId} ${ref.stepId}`;
        byStep.set(step, [...(byStep.get(step) ?? []), lease.attemptKey]);
      }
      for (const [step, keys] of byStep) {
        assert.equal(keys.length, 1, `step ${step} has live leases ${keys.join(', ')}`);
      }
    },
  }));
