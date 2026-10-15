import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { Event } from '../../src/schemas/events.ts';
import { generateEvents } from '../helpers/event-sequences.ts';

// A fresh seed per run explores new sequences; FOEDRUM_SEED replays a failing one.
const firstSeed = Number(process.env.FOEDRUM_SEED ?? randomInt(2 ** 31));
const runs = process.env.FOEDRUM_SEED === undefined ? 200 : 1;
// Otherwise a mistyped seed runs no case at all, and every property passes.
if (!Number.isSafeInteger(firstSeed)) {
  throw new Error(`FOEDRUM_SEED must be an integer, got ${process.env.FOEDRUM_SEED}`);
}

const forEachSeed = (property: (seed: number) => void): void => {
  for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
    try {
      property(seed);
    } catch (error) {
      // Rethrow the original error, so the report still shows the failed assertion or the
      // code under test; only the message gains the seed.
      if (error instanceof Error) {
        error.message += `\nSeed ${seed}: set the environment variable FOEDRUM_SEED to ${seed} to replay it.`;
      }
      throw error;
    }
  }
};

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
          const { batchId, stepId, attempt } = effectKey.decode(event.key);
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
