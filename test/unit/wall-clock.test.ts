// A time as a person reads it (ADR 0386): an ISO instant to the minute in UTC, any other text as it is.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { utcMinute } from '../../src/engine/wall-clock.ts';

describe('utcMinute (ADR 0386)', () => {
  it('writes an instant to the minute in UTC, without seconds or a T', () => {
    assert.equal(utcMinute('2026-11-12T13:36:59.098Z'), '2026-11-12 13:36 UTC');
  });

  it('leaves a text that is no instant as it is', () => {
    assert.equal(utcMinute('soon'), 'soon');
  });
});
