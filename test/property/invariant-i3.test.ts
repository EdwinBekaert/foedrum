// Invariant I3 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { holdsInScenarios } from '../helpers/property.ts';
import { farFuture } from '../helpers/simulation.ts';

it('I3: replaying the log yields identical state', () =>
  holdsInScenarios({
    atEnd: (engine) => {
      const log = engine.events();
      assert.deepStrictEqual(fold(log), engine.state(), 'folded at once and as it grew');
      // A new store from the log as the state branch gives it back: JSON text (ADR 0011).
      const replayed = openSqliteEventStore(':memory:');
      try {
        replayed.replay(JSON.parse(JSON.stringify(log)));
        const again = replayed.eventsAfter(0).map(({ event }) => event);
        assert.deepStrictEqual(fold(again), engine.state(), 'the replayed state');
        assert.deepStrictEqual(
          replayed.batchesPastDeadline(farFuture),
          engine.store.batchesPastDeadline(farFuture),
          'the replayed deadlines',
        );
        for (const key of engine.state().effects.keys()) {
          const parts = effectKey.decode(key);
          assert.deepStrictEqual(replayed.findEffect(parts), engine.store.findEffect(parts), key);
        }
      } finally {
        replayed.close();
      }
    },
  }));
