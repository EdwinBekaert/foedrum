// A time as a person reads it (ADR 0379): day, month, hour and minute in UTC.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { whenText } from '../../src/engine/when.ts';

describe('whenText', () => {
  it('writes an ISO time as day, month, hour and minute in UTC', () => {
    assert.equal(whenText('2026-11-13T19:16:04.284Z'), '13 Nov 19:16 UTC');
  });

  it('writes a time given in another zone in UTC, the hour in 24 hours', () => {
    assert.equal(whenText('2026-01-05T08:07:00+02:00'), '5 Jan 06:07 UTC');
    assert.equal(whenText(new Date('2026-12-31T23:59:59.999Z')), '31 Dec 23:59 UTC');
    assert.equal(whenText('2026-03-01T00:00:00Z'), '1 Mar 00:00 UTC');
  });
});
