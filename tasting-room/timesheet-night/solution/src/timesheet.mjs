// What timesheet does with a day's shifts: plain data in, plain data out.

import { parseTime } from './time.mjs';

const DAY_MINUTES = 24 * 60;

/** `shifts` in the order they start. */
export function byStart(shifts) {
  return [...shifts].sort((a, b) => parseTime(a.start) - parseTime(b.start));
}

/** How many minutes a shift from `start` to `end` lasts; one that ends before it starts ends the next day. */
export function shiftMinutes(start, end) {
  return (parseTime(end) - parseTime(start) + DAY_MINUTES) % DAY_MINUTES;
}

/** The minutes of a day's `shifts` together. */
export function dayMinutes(shifts) {
  return shifts.reduce((sum, shift) => sum + shiftMinutes(shift.start, shift.end), 0);
}
