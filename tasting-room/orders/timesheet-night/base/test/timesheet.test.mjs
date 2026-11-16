import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTime } from '../src/time.mjs';
import { byStart } from '../src/timesheet.mjs';

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
