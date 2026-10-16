import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { Event } from '../../src/schemas/events.ts';
import type { AttemptEffectKey } from '../../src/schemas/store.ts';
import { generateEvents } from '../helpers/event-sequences.ts';
import { forEachSeed as forSeeds } from '../helpers/property.ts';

// A fresh seed per run explores new sequences; FOEDRUM_SEED replays a failing one.
const forEachSeed = (property: (seed: number) => void): void => forSeeds(200, property);

describe('generated event sequences', () => {
  it('are valid events', () => {
    forEachSeed((seed) => {
      for (const event of generateEvents(seed)) Event.parse(event);
    });
  });

  it('apply effects only to attempts scheduled earlier in the sequence', () => {
    let effects = 0;
    forEachSeed((seed) => {
      const scheduled = new Set<string>();
      for (const event of generateEvents(seed)) {
        if (event.type === 'step.scheduled') {
          scheduled.add(JSON.stringify([event.batchId, event.stepId, event.attempt]));
        }
        if (event.type === 'effect.applied') {
          // The generated sequences apply effects of attempts only.
          const { batchId, stepId, attempt } = effectKey.decode(event.key) as AttemptEffectKey;
          assert.ok(scheduled.has(JSON.stringify([batchId, stepId, attempt])), event.key);
          effects++;
        }
      }
    });
    assert.ok(effects > 0, 'some sequence applies an effect');
  });

  it('are the same for the same seed', () => {
    forEachSeed((seed) => assert.deepStrictEqual(generateEvents(seed), generateEvents(seed)));
  });
});

describe('fold (invariant I3)', () => {
  it('yields identical state when the same events are replayed', () => {
    forEachSeed((seed) => {
      const events = generateEvents(seed);
      assert.deepStrictEqual(fold(events), fold(structuredClone(events)));
    });
  });

  it('yields the same state when folded in two halves', () => {
    forEachSeed((seed) => {
      const events = generateEvents(seed);
      const at = seed % (events.length + 1);
      assert.deepStrictEqual(fold(events.slice(at), fold(events.slice(0, at))), fold(events));
    });
  });

  it('changes neither the events nor the state it starts from', () => {
    forEachSeed((seed) => {
      const events = generateEvents(seed);
      const at = seed % (events.length + 1);
      const prefix = fold(events.slice(0, at));
      const before = structuredClone({ events, prefix });
      fold(events.slice(at), prefix);
      assert.deepStrictEqual({ events, prefix }, before);
    });
  });
});

describe('fold state', () => {
  it('keeps an issue in at most one of orders and sub-orders', () => {
    forEachSeed((seed) => {
      const state = fold(generateEvents(seed));
      const both = [...state.orders.keys()].filter((issue) => state.subOrders.has(issue));
      assert.deepStrictEqual(both, []);
    });
  });

  it('lists every batch on exactly one order or sub-order', () => {
    forEachSeed((seed) => {
      const state = fold(generateEvents(seed));
      const listed = [...state.orders.values(), ...state.subOrders.values()]
        .flatMap((issue) => issue.batchIds)
        .sort();
      assert.deepStrictEqual(listed, [...state.batches.keys()].sort());
    });
  });
});
