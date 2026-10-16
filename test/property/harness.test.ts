// The property harness itself (test/helpers/property.ts): a broken invariant must fail, name its
// seed and come back shrunk, or every invariant property could pass without checking anything.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holdsInScenarios } from '../helpers/property.ts';

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
