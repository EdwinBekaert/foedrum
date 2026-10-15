// Invariant I2 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { holdsInScenarios } from '../helpers/property.ts';

it('I2: at most one live lease per attempt and per worktree', () =>
  holdsInScenarios({
    afterMove: (engine) => {
      // Every attempt of a batch works in the batch's task worktree, never two at once
      // (ADR 0012), so one live lease per batch is one per attempt and one per worktree.
      const byBatch = new Map<string, string[]>();
      for (const lease of engine.store.currentLeases(engine.now())) {
        const ref = attemptKey.decode(lease.attemptKey);
        assert.ok(ref, `lease ${lease.attemptKey} names an attempt`);
        byBatch.set(ref.batchId, [...(byBatch.get(ref.batchId) ?? []), lease.attemptKey]);
      }
      for (const [batchId, keys] of byBatch) {
        assert.equal(keys.length, 1, `batch ${batchId} has live leases ${keys.join(', ')}`);
      }
    },
  }));
