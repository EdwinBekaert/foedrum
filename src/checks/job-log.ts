// The part of a failed GitHub Actions job's log that goes with its batch back to a fix step
// (ADR 0228): the failing step up to its first error, read for secrets and cut to a tail.

/** The excerpt of `log` a record keeps. */
export function jobLogExcerpt(_log: string): string {
  throw new Error('not implemented');
}
