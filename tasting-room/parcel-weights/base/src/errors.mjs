// The error for a value a person typed that cannot be read (CLAUDE.md).

/** A typed value refused: the counter shows its message and asks again. */
export class InputError extends Error {
  name = 'InputError';
}
