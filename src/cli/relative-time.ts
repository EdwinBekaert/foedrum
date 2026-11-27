// A time as the terminal says it (ADR 0428, ADR 0386): the UTC minute the status comment shows, and
// how long ago it was, which a comment cannot say without being edited every minute.

import { utcMinute } from '../engine/wall-clock.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `ms` in a unit of `big` milliseconds and the `small` ones left, which are left out when none are. */
const inTwoUnits = (ms: number, big: [string, number], small: [string, number]): string => {
  const first = `${Math.floor(ms / big[1])} ${big[0]}`;
  const left = Math.floor((ms % big[1]) / small[1]);
  return left === 0 ? first : `${first} ${left} ${small[0]}`;
};

/** How long `ms` is: `4 min`, `1 h 5 min`, `2 d`. */
const agoText = (ms: number): string => {
  if (ms >= DAY) return inTwoUnits(ms, ['d', DAY], ['h', HOUR]);
  if (ms >= HOUR) return inTwoUnits(ms, ['h', HOUR], ['min', MINUTE]);
  return `${Math.floor(ms / MINUTE)} min`;
};

/** `iso` as its UTC minute and, when it is not ahead of `now`, how long ago it was: `(4 min)`. */
export const withAge = (iso: string, now: Date): string => {
  const instant = Date.parse(iso);
  const ago = now.getTime() - instant;
  // A text that is no instant, and a time ahead, have no age.
  return Number.isNaN(instant) || ago < 0 ? utcMinute(iso) : `${utcMinute(iso)} (${agoText(ago)})`;
};
