// Times of day (CLAUDE.md).

/** The minutes since midnight of `text`, a time of day as `HH:MM`. */
export function parseTime(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (match === null || hours > 23 || minutes > 59)
    throw new Error(`${text} is not a time as HH:MM`);
  return hours * 60 + minutes;
}
