// The property harness itself (test/helpers/property.ts): a broken invariant must fail, name its
// seed and come back shrunk, or every invariant property could pass without checking anything.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holdsInScenarios, runsIn } from '../helpers/property.ts';

describe('holdsInScenarios', () => {
  it('fails a broken invariant with its seed, shrunk to the one move that breaks it', async () => {
    await assert.rejects(
      holdsInScenarios({
        atEnd: (engine) => {
          if (engine.events().some((event) => event.type === 'batch.ordered')) {
            throw new Error('a batch was ordered');
          }
        },
      }),
      (error: Error) => {
        assert.match(error.message, /^a batch was ordered\n/);
        assert.match(error.message, /set the environment variable FOEDRUM_SEED to \d+/);
        assert.match(
          error.message,
          /Shrunk from [1-9]\d+ moves and \d+ plays? to 1 move and 0 plays\./,
        );
        assert.match(error.message, /\nEvents:\n +1\. batch\.ordered /);
        return true;
      },
    );
  });

  it('names the first failure when the shrunk scenario fails another way', async () => {
    await assert.rejects(
      holdsInScenarios({
        atEnd: (engine) => {
          const events = engine.events().length;
          if (events > 0) throw new Error(`${events} events`);
        },
      }),
      (error: Error) => {
        assert.match(error.message, /^1 events\n/);
        assert.match(error.message, /\nFirst found as: \d+ events/);
        return true;
      },
    );
  });
});

describe('the scenarios', () => {
  it("play the failing mark, its Stuck, its recovery and a person's way out of it (ADR 0335)", async () => {
    const seen = new Set<string>();
    await holdsInScenarios({
      atEnd: (engine) => {
        const onFailing = new Set<string>();
        for (const event of engine.events()) {
          if (event.type === 'batch.failing' || event.type === 'batch.recovered') {
            seen.add(event.type);
          }
          if (event.type === 'batch.stuck') {
            if (event.reason.kind === 'failing') {
              seen.add('stuck on failing');
              onFailing.add(event.batchId);
            } else onFailing.delete(event.batchId);
          }
          if (event.type === 'batch.resumed' && onFailing.delete(event.batchId)) {
            seen.add('out of failing');
          }
        }
      },
    });
    assert.deepStrictEqual([...seen].sort(), [
      'batch.failing',
      'batch.recovered',
      'out of failing',
      'stuck on failing',
    ]);
  });
});

// A file that runs a count of its own reads it as every property does (ADR 0243).
describe('runsIn', () => {
  it("gives the file's own count when FOEDRUM_RUNS is unset", () => {
    assert.equal(runsIn({}, 3), 3);
  });

  it('gives the count FOEDRUM_RUNS sets', () => {
    assert.equal(runsIn({ FOEDRUM_RUNS: '200' }, 3), 200);
    assert.equal(runsIn({ FOEDRUM_RUNS: '1' }, 3), 1);
  });

  it('refuses a mistyped count, which would run no case at all', () => {
    for (const value of ['', '0', '-2', '1.5', 'many']) {
      assert.throws(
        () => runsIn({ FOEDRUM_RUNS: value }, 3),
        new Error(`FOEDRUM_RUNS must be an integer of at least 1, got ${value}`),
      );
    }
  });
});
