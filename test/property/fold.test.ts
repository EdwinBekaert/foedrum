import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { describe, it } from 'node:test';
import { fold } from '../../src/engine/fold.ts';
import { Event } from '../../src/schemas/events.ts';
import { generateEvents } from '../helpers/event-sequences.ts';

// A fresh seed per run explores new sequences; FOEDRUM_SEED replays a failing one.
const firstSeed = Number(process.env.FOEDRUM_SEED ?? randomInt(2 ** 31));
const runs = process.env.FOEDRUM_SEED === undefined ? 200 : 1;

const forEachSeed = (property: (seed: number) => void): void => {
  for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
    try {
      property(seed);
    } catch (error) {
      throw new Error(`Failed for seed ${seed}; replay with FOEDRUM_SEED=${seed}`, {
        cause: error,
      });
    }
  }
};

describe('generated event sequences', () => {
  it('are valid events', () => {
    forEachSeed((seed) => {
      for (const event of generateEvents(seed)) Event.parse(event);
    });
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
