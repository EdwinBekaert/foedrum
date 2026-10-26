// `foedrum pause --by <time>` (ADR 0202): a local time or a duration, as a UTC instant.

/**
 * The instant `text` names at `now` in the time zone `zone`: `HH:MM` today there, or tomorrow when
 * that has passed; or a duration (`20m`) from now. A reason when it is neither.
 */
export const stopInstant = (
  _text: string,
  _now: Date,
  _zone: string,
): { at: Date } | { refused: string } => {
  throw new Error('not implemented');
};
