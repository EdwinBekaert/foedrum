// `foedrum pause --by <time>` (ADR 0202): a local time today, or tomorrow once it has passed, in
// the machine's zone, or a duration from now; recorded as a UTC instant.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stopInstant } from '../../src/cli/pause-time.ts';

// 15:00 in Brussels (UTC+1 in winter), 10:00 in New York.
const now = new Date('2026-11-02T14:00:00.000Z');
const instant = (text: string, zone: string, at = now): string => {
  const result = stopInstant(text, at, zone);
  assert.ok('at' in result, JSON.stringify(result));
  return result.at.toISOString();
};

describe('stopInstant (ADR 0202)', () => {
  it("takes a local time later today in the machine's zone", () => {
    assert.equal(instant('17:30', 'Europe/Brussels'), '2026-11-02T16:30:00.000Z');
    assert.equal(instant('17:30', 'America/New_York'), '2026-11-02T22:30:00.000Z');
    assert.equal(instant('17:30', 'UTC'), '2026-11-02T17:30:00.000Z');
  });

  it('takes tomorrow when the time has passed today, or is now', () => {
    assert.equal(instant('09:15', 'Europe/Brussels'), '2026-11-03T08:15:00.000Z');
    assert.equal(instant('15:00', 'Europe/Brussels'), '2026-11-03T14:00:00.000Z');
  });

  it("takes the local date, not UTC's, when they differ", () => {
    // 01:00 on 3 November in Brussels is still 2 November in UTC.
    const late = new Date('2026-11-03T00:00:00.000Z');
    assert.equal(instant('02:00', 'Europe/Brussels', late), '2026-11-03T01:00:00.000Z');
    assert.equal(instant('00:30', 'Europe/Brussels', late), '2026-11-03T23:30:00.000Z');
  });

  it('keeps the local time across a change of clocks', () => {
    // Brussels goes from UTC+2 to UTC+1 at 03:00 on 25 October 2026.
    const before = new Date('2026-10-24T20:00:00.000Z');
    assert.equal(instant('17:30', 'Europe/Brussels', before), '2026-10-25T16:30:00.000Z');
    // Before the change that night, still on summer time.
    assert.equal(instant('01:30', 'Europe/Brussels', before), '2026-10-24T23:30:00.000Z');
    // 02:30 on 29 March 2026 never shows on a clock there: it is read as 03:30 summer time.
    const spring = new Date('2026-03-28T20:00:00.000Z');
    assert.equal(instant('02:30', 'Europe/Brussels', spring), '2026-03-29T01:30:00.000Z');
  });

  it('takes a duration from now', () => {
    assert.equal(instant('20m', 'Europe/Brussels'), '2026-11-02T14:20:00.000Z');
    assert.equal(instant('2h', 'UTC'), '2026-11-02T16:00:00.000Z');
  });

  it('refuses what is neither, with what it takes', () => {
    for (const text of ['24:00', '17:60', '7:30', '17h30', 'tonight', '0m', '-5m', '']) {
      const result = stopInstant(text, now, 'UTC');
      assert.ok('refused' in result, text);
      assert.match(result.refused, /HH:MM.*20m/);
    }
  });
});
