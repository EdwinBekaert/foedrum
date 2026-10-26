// A wall clock in an IANA time zone: what `pause --by` (ADR 0202) and a usage window's reset
// (ADR 0206) read a local time with.

/** The wall-clock fields of `instant` in `zone`, as a UTC time in milliseconds. */
export const wallClock = (instant: number, zone: string): number => {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, Number(value)]),
  );
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = fields;
  return Date.UTC(year, month - 1, day, hour, minute, second);
};

/** The instant whose wall clock in `zone` reads `local` (a UTC time of those fields). */
export const fromWallClock = (local: number, zone: string): number => {
  // The zone's offset at a first guess, then at the instant that guess gives: right across a
  // change of clocks.
  const guess = local - (wallClock(local, zone) - local);
  return local - (wallClock(guess, zone) - guess);
};
