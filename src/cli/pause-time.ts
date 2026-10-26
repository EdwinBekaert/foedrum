// `foedrum pause --by <time>` (ADR 0202): a local time or a duration, as a UTC instant.

import { fromWallClock, wallClock } from '../engine/wall-clock.ts';
import { LocalTime, STOP_TIME_HELP } from '../schemas/commands.ts';
import { Duration, durationMs } from '../schemas/primitives.ts';

/**
 * The instant `text` names at `now` in the time zone `zone`: `HH:MM` today there, or tomorrow when
 * that has passed; or a duration (`20m`) from now. A reason when it is neither.
 */
export const stopInstant = (
  text: string,
  now: Date,
  zone: string,
): { at: Date } | { refused: string } => {
  if (Duration.safeParse(text).success) return { at: new Date(now.getTime() + durationMs(text)) };
  if (!LocalTime.safeParse(text).success) return { refused: STOP_TIME_HELP };
  const [hours, minutes] = text.split(':').map(Number);
  let today: Date;
  try {
    today = new Date(wallClock(Math.floor(now.getTime() / 1000) * 1000, zone));
  } catch (error) {
    // ICU reports Etc/Unknown when it cannot tell the machine's zone, and rejects it as a zone.
    if (!(error instanceof RangeError)) throw error;
    return {
      refused: `this machine reports its time zone as ${zone}, which it cannot read a local time in; give --by as a duration, such as 20m`,
    };
  }
  const at = (days: number) =>
    fromWallClock(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + days,
        hours ?? 0,
        minutes ?? 0,
      ),
      zone,
    );
  const later = at(0);
  return { at: new Date(later > now.getTime() ? later : at(1)) };
};
