// Days as dates, `YYYY-MM-DD` (CLAUDE.md).

const DAY_MS = 24 * 60 * 60 * 1000;

/** The days from `from` to `to`, both dates as `YYYY-MM-DD`. */
export function daysBetween(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
}
