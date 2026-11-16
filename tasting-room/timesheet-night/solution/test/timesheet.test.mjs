import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTime } from '../src/time.mjs';
import { byStart, dayMinutes, shiftMinutes } from '../src/timesheet.mjs';

test('reads a time of day as minutes since midnight', () => {
  assert.deepEqual([parseTime('00:00'), parseTime('09:30'), parseTime('23:59')], [0, 570, 1439]);
});

test('refuses a time that is not HH:MM', () => {
  for (const text of ['9:30', '24:00', '12:60', 'noon']) assert.throws(() => parseTime(text));
});

test('puts shifts in the order they start', () => {
  const shifts = [
    { start: '14:00', end: '22:00' },
    { start: '06:00', end: '14:00' },
  ];
  assert.deepEqual(
    byStart(shifts).map((shift) => shift.start),
    ['06:00', '14:00'],
  );
});

test('counts the minutes of a shift, a night shift ending the next day', () => {
  assert.equal(shiftMinutes('09:00', '17:30'), 510);
  assert.equal(shiftMinutes('21:00', '07:00'), 600);
});

test("adds up a day's shifts", () => {
  assert.equal(
    dayMinutes([
      { start: '06:00', end: '14:00' },
      { start: '21:00', end: '07:00' },
    ]),
    1080,
  );
});
