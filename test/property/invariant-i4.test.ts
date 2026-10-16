// Invariant I4 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { emptyState, fold } from '../../src/engine/fold.ts';
import type { AttemptEffectKey } from '../../src/schemas/store.ts';
import { holdsInScenarios } from '../helpers/property.ts';

it('I4: every side effect of an attempt is keyed (batch, step, attempt, effect) and applied at most once', () =>
  holdsInScenarios({
    atEnd: (engine) => {
      const applied = new Set<string>();
      let state = emptyState;
      for (const event of engine.events()) {
        if (event.type === 'effect.applied') {
          const { key } = event;
          assert.ok(!applied.has(key), `effect ${key} is applied once`);
          applied.add(key);
          const parts = effectKey.decode(key);
          // The scenarios apply effects of attempts only.
          const { batchId, stepId, attempt } = parts as AttemptEffectKey;
          const attempts = state.batches.get(batchId)?.steps.get(stepId)?.attempts;
          assert.ok(attempts?.has(attempt), `effect ${key} is of an attempt the log created`);
          assert.deepStrictEqual(engine.store.findEffect(parts), { result: event.result }, key);
        }
        state = fold([event], state);
      }
    },
  }));
