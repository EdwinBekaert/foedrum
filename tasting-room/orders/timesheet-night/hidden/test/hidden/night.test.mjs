import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as timesheet from '../../src/timesheet.mjs';

test('a day shift lasts from its start to its end', () => {
  assert.equal(timesheet.shiftMinutes('09:00', '17:30'), 510);
});

test('a night shift ends the next morning', () => {
  assert.equal(timesheet.shiftMinutes('22:00', '06:00'), 480);
  assert.equal(timesheet.shiftMinutes('23:30', '00:15'), 45);
});

test("a day's shifts add up, night shifts included", () => {
  const shifts = [
    { start: '07:00', end: '15:00' },
    { start: '22:00', end: '06:00' },
  ];
  assert.equal(timesheet.dayMinutes(shifts), 960);
});
