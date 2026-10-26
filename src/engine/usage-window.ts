// The usage window (ADR 0206): when claude hits a usage limit, no brewer attempt starts until the
// reset it named, read in the machine's time zone.

import type { UsageWindow } from './fold.ts';

/** Added to the reset, so the first attempt after it does not meet a window still closed. */
export const reopenMarginMs = 5 * 60_000;
/** How long the window stays closed when the reset cannot be read. */
export const unreadRetryMs = 60 * 60_000;

/**
 * When the window whose reset claude wrote as `resets` reopens, read at `now` in `zone`: the next
 * moment that matches (`3:45pm`, `Mon 12:00am`) plus the margin, or an hour on when unread.
 */
export const reopenOf = (
  _resets: string,
  _now: Date,
  _zone: string,
): { at: Date; read: boolean } => {
  throw new Error('not implemented');
};

/** The line the status comment and `foedrum status` show while the window is closed. */
export const usageWindowText = (_window: UsageWindow): string => {
  throw new Error('not implemented');
};
