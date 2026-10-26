// The usage windows (ADR 0206, ADR 0215): when claude hits a usage limit, no brewer attempt that
// limit's window holds starts until the reset it named, read in the machine's time zone.

import { type UsageLimitName, UsageScope } from '../schemas/events.ts';
import type { UsageWindow, UsageWindows } from './fold.ts';
import { fromWallClock, wallClock } from './wall-clock.ts';

/** Added to the reset, so the first attempt after it does not meet a window still closed. */
export const reopenMarginMs = 5 * 60_000;
/** How long the window stays closed when the reset cannot be read. */
export const unreadRetryMs = 60 * 60_000;
/**
 * How long ago a reset that matches may have been and still be the one claude named: the end may
 * be handled minutes after claude wrote it, and claude names the reset to the minute.
 */
export const passedWithinMs = 60 * 60_000;

/** A model family whose own usage limit claude names: an Opus or a Sonnet window (ADR 0215). */
export type ModelFamily = Exclude<UsageScope, 'all'>;

/**
 * The family of a model id or family as `claude --model` takes it, by its words (`opus` or
 * `sonnet`); undefined when it cannot be told, and every limit holds it (ADR 0215).
 */
export const familyOf = (model: string): ModelFamily | undefined => {
  const words = new Set(model.toLowerCase().split(/[^a-z0-9]+/));
  const opus = words.has('opus');
  if (opus === words.has('sonnet')) return undefined;
  return opus ? 'Opus' : 'Sonnet';
};

/** Whose brewers the window of `limit` holds: a session or weekly limit every brewer's. */
export const scopeOf = (limit: UsageLimitName): UsageScope =>
  limit === 'Opus' || limit === 'Sonnet' ? limit : 'all';

/**
 * Whether `windows` hold a brewer attempt on `family`: the window of every brewer, its family's,
 * or any window when its family cannot be told (ADR 0215).
 */
export const windowHolds = (windows: UsageWindows, family: ModelFamily | undefined): boolean =>
  windows.all !== undefined ||
  (family === undefined ? Object.keys(windows).length > 0 : windows[family] !== undefined);

/** When a closed usage window reopens, and whether claude's reset could be read. */
export interface Reopen {
  at: Date;
  read: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The documented forms only (ADR 0091): `3:45pm`, or a weekday before it, `Mon 12:00am`. */
const RESET = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?(1[0-2]|[1-9]):([0-5]\d)(am|pm)$/;

/** The instant `resets` names at `now` in `zone`: the next moment that matches, if it can tell. */
const resetOf = (resets: string, now: Date, zone: string): number | undefined => {
  const found = RESET.exec(resets);
  if (found === null) return undefined;
  const [, weekday, hour = '', minute = '', half] = found;
  const hours = (Number(hour) % 12) + (half === 'pm' ? 12 : 0);
  let today: Date;
  try {
    today = new Date(wallClock(now.getTime(), zone));
  } catch (error) {
    // ICU reports Etc/Unknown when it cannot tell the machine's zone, and rejects it as a zone.
    if (!(error instanceof RangeError)) throw error;
    return undefined;
  }
  const at = (days: number) =>
    fromWallClock(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + days,
        hours,
        Number(minute),
      ),
      zone,
    );
  // Today or the coming weekday; once that moment passed over an hour ago, a day or a week on.
  const first = weekday === undefined ? 0 : (WEEKDAYS.indexOf(weekday) - today.getUTCDay() + 7) % 7;
  const step = weekday === undefined ? 1 : 7;
  const since = now.getTime() - passedWithinMs;
  // Across midnight the hour before is yesterday's, or last week's weekday: always past.
  const before = at(first - step);
  if (before >= since) return before;
  const soonest = at(first);
  return soonest >= since ? soonest : at(first + step);
};

/**
 * When the window whose reset claude wrote as `resets` reopens, read at `now` in `zone`: the next
 * moment that matches (`3:45pm`, `Mon 12:00am`) plus the margin, or an hour on when unread.
 */
export const reopenOf = (resets: string, now: Date, zone: string): Reopen => {
  const reset = resetOf(resets, now, zone);
  return reset === undefined
    ? { at: new Date(now.getTime() + unreadRetryMs), read: false }
    : { at: new Date(reset + reopenMarginMs), read: true };
};

const utc = (instant: Date): string => {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  }).format(instant);
  return `${time} UTC, ${day}`;
};

/** The line the status comment and `foedrum status` show while the window is closed. */
export const usageWindowText = ({ limit, resets, reopensAt, read }: UsageWindow): string => {
  const scope = scopeOf(limit);
  // A family's window names the family, and the brewers it holds (ADR 0215).
  const [window, brewers] =
    scope === 'all'
      ? ['Usage window', 'brewers']
      : [`${scope} usage window`, `brewers on ${scope}`];
  return `${window} closed: claude hit its ${limit} limit, which resets ${resets}; ${brewers} ${read ? 'wait until' : 'try again at'} ${utc(new Date(reopensAt))}`;
};

/** A line for each closed window: every brewer's first, then Opus's, then Sonnet's (ADR 0215). */
export const usageWindowsText = (windows: UsageWindows): string[] =>
  UsageScope.options.flatMap((scope) => {
    const window = windows[scope];
    return window === undefined ? [] : [usageWindowText(window)];
  });
