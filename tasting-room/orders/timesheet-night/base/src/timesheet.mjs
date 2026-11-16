// What timesheet does with a day's shifts: plain data in, plain data out.

import { parseTime } from './time.mjs';

/** `shifts` in the order they start. */
export function byStart(shifts) {
  return [...shifts].sort((a, b) => parseTime(a.start) - parseTime(b.start));
}
