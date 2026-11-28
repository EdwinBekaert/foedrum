// A time as the terminal says it (ADR 0386, #1173): the UTC minute, then how long ago it was.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withAge } from '../../src/cli/relative-time.ts';

const since = '2026-11-19T13:11:21.291Z';
/** `ms` after `since`. */
const after = (ms: number): Date => new Date(Date.parse(since) + ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('withAge', () => {
  it('adds the minutes since a time to its UTC minute', () => {
    assert.equal(withAge(since, after(4 * MINUTE + 9_000)), '2026-11-19 13:11 UTC (4 min)');
  });

  it('says 0 min for less than a minute', () => {
    assert.equal(withAge(since, after(0)), '2026-11-19 13:11 UTC (0 min)');
    assert.equal(withAge(since, after(59_000)), '2026-11-19 13:11 UTC (0 min)');
  });

  it('counts whole minutes up to 59', () => {
    assert.equal(withAge(since, after(59 * MINUTE + 59_000)), '2026-11-19 13:11 UTC (59 min)');
  });

  it('says hours and the minutes left from an hour on, and only the hours when none are left', () => {
    assert.equal(withAge(since, after(HOUR + 5 * MINUTE)), '2026-11-19 13:11 UTC (1 h 5 min)');
    assert.equal(withAge(since, after(2 * HOUR)), '2026-11-19 13:11 UTC (2 h)');
  });

  it('says days and the hours left from a day on, and no minutes', () => {
    assert.equal(withAge(since, after(25 * HOUR + 5 * MINUTE)), '2026-11-19 13:11 UTC (1 d 1 h)');
    assert.equal(withAge(since, after(48 * HOUR)), '2026-11-19 13:11 UTC (2 d)');
  });

  it('adds nothing to a time that is ahead of now', () => {
    assert.equal(withAge(since, after(-MINUTE)), '2026-11-19 13:11 UTC');
  });

  it('gives a text that is no instant as it is, with no age', () => {
    assert.equal(withAge('soon', after(MINUTE)), 'soon');
  });
});
