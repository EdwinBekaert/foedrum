// A time as the terminal says it (ADR 0386, #1173): the UTC minute the status comment shows, and
// how long ago it was, which a comment cannot say without being edited every minute.

/** `iso` as its UTC minute and, when it is not ahead of `now`, how long ago it was: `(4 min)`. */
export const withAge = (_iso: string, _now: Date): string => {
  throw new Error('not implemented');
};
